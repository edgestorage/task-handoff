import axios from "axios";
import crypto from "node:crypto";
import qrcode from "qrcode-terminal";
import retry from "async-retry";
import { z } from "zod";
import type { ChatBridgeCapabilities, ChatPayload, ChatRoute } from "@task-handoff/core/core/chat";
import { renderPlainChatPayload } from "@task-handoff/core/core/chat-render";
import { color } from "@task-handoff/terminal-ui";

const DEFAULT_BASE_URL = `https://ilinkai.${"wei"}${"xin"}.qq.com`;
const CHANNEL_VERSION = "1.0.2";
const WechatResponseSchema = z
  .object({
    ret: z.number().optional(),
    errcode: z.number().optional(),
    errmsg: z.string().optional(),
    msg: z.unknown().optional(),
    qrcode: z.string().optional(),
    qrcode_img_content: z.string().optional(),
    qrcode_url: z.string().optional(),
    url: z.string().optional(),
    status: z.enum(["wait", "scaned", "confirmed", "expired"]).or(z.string()).optional(),
    bot_token: z.string().optional(),
    ilink_bot_id: z.string().optional(),
    ilink_user_id: z.string().optional(),
    baseurl: z.string().optional(),
    get_updates_buf: z.string().optional(),
    msgs: z.array(z.unknown()).optional(),
  })
  .passthrough();

type WechatApiResponse = z.infer<typeof WechatResponseSchema>;

function randomUin() {
  const value = crypto.randomInt(0, 2 ** 32 - 1);
  return Buffer.from(String(value)).toString("base64");
}

type WechatTargetRoute = Partial<ChatRoute> & {
  target?: {
    chatId?: unknown;
    contextToken?: unknown;
  };
};

type WechatRequestOptions = {
  method?: string;
  body?: unknown;
  signal?: AbortSignal;
};

type WechatCdnMedia = {
  encrypt_query_param?: string;
  aes_key?: string;
  encrypt_type?: number;
  full_url?: string;
};

type WechatTextItem = {
  text?: string;
};

type WechatImageItem = {
  media?: WechatCdnMedia;
  thumb_media?: WechatCdnMedia;
  aeskey?: string;
  url?: string;
  mid_size?: number;
  thumb_size?: number;
  thumb_width?: number;
  thumb_height?: number;
  hd_size?: number;
};

type WechatVoiceItem = {
  media?: WechatCdnMedia;
  encode_type?: number;
  text?: string;
  playtime?: number;
};

type WechatFileItem = {
  media?: WechatCdnMedia;
  file_name?: string;
  md5?: string;
  len?: string;
};

type WechatVideoItem = {
  media?: WechatCdnMedia;
  video_size?: number;
  play_length?: number;
  thumb_media?: WechatCdnMedia;
};

type WechatMessageItem = {
  type: 1 | 2 | 3 | 4 | 5;
  text_item?: WechatTextItem;
  image_item?: WechatImageItem;
  voice_item?: WechatVoiceItem;
  file_item?: WechatFileItem;
  video_item?: WechatVideoItem;
  ref_msg?: {
    title?: string;
    message_item?: WechatMessageItem;
  };
};

type WechatWireMessage = {
  seq?: number;
  message_id?: number;
  from_user_id: string;
  to_user_id?: string;
  client_id?: string;
  create_time_ms?: number;
  message_type: 1 | 2;
  message_state?: 0 | 1 | 2;
  context_token?: string;
  item_list?: WechatMessageItem[];
};

type WechatBridgeOptions = {
  token?: string;
  baseUrl?: string;
  chatId?: string;
  contextToken?: string;
  updatesBuf?: string;
  multiChat?: boolean;
  onText: (text: string, meta?: { chatId?: string; contextToken?: string }) => unknown | Promise<unknown>;
  onLog: (message: string) => void;
  onChange?: (state: {
    token?: string;
    baseUrl?: string;
    chatId?: string;
    contextToken?: string;
    updatesBuf?: string;
  }) => void;
};

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function isWechatWireMessage(value: unknown): value is WechatWireMessage {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const message = value as Partial<WechatWireMessage>;
  return typeof message.from_user_id === "string" && (message.message_type === 1 || message.message_type === 2);
}

function textFromMessage(message: WechatWireMessage) {
  const item = message.item_list?.find((entry) => entry.type === 1 && entry.text_item?.text);
  return item?.text_item?.text;
}

function renderQr(value: string) {
  let output = value;
  qrcode.generate(value, { small: true }, (code) => {
    output = code;
  });
  return output;
}

class WechatBridge {
  token?: string;
  baseUrl: string;
  chatId?: string;
  contextToken?: string;
  updatesBuf: string;
  enabled: boolean;
  multiChat: boolean;
  polling: boolean;
  abortController?: AbortController;
  onText: (text: string, meta?: { chatId?: string; contextToken?: string }) => unknown | Promise<unknown>;
  onLog: (message: string) => void;
  onChange?: (state: {
    token?: string;
    baseUrl?: string;
    chatId?: string;
    contextToken?: string;
    updatesBuf?: string;
  }) => void;
  capabilities: ChatBridgeCapabilities;

  constructor({ token, baseUrl, chatId, contextToken, updatesBuf, multiChat = false, onText, onLog, onChange }: WechatBridgeOptions) {
    this.token = token;
    this.baseUrl = baseUrl || DEFAULT_BASE_URL;
    this.chatId = chatId;
    this.contextToken = contextToken;
    this.updatesBuf = updatesBuf || "";
    this.enabled = Boolean(token);
    this.multiChat = Boolean(multiChat);
    this.polling = false;
    this.abortController = undefined;
    this.onText = onText;
    this.onLog = onLog;
    this.onChange = onChange;
    this.capabilities = {
      markdown: false,
      buttons: false,
      editMessage: false,
      deleteMessage: false,
      reaction: false,
      progress: false,
      plainTextOnly: true,
    };
  }

  statusLines() {
    return [
      `enabled: ${this.enabled ? "yes" : "no"}`,
      `token: ${this.token ? "set" : "not set"}`,
      `base url: ${this.baseUrl}`,
      `chat id: ${this.chatId || "not set"}`,
      `context token: ${this.contextToken ? "set" : "not set"}`,
      `polling: ${this.polling ? "yes" : "no"}`,
    ];
  }

  headers() {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      AuthorizationType: "ilink_bot_token",
      "X-WECHAT-UIN": randomUin(),
    };
    if (this.token) {
      headers.Authorization = `Bearer ${this.token}`;
    }
    return headers;
  }

  emitChange() {
    this.onChange?.({
      token: this.token,
      baseUrl: this.baseUrl,
      chatId: this.chatId,
      contextToken: this.contextToken,
      updatesBuf: this.updatesBuf,
    });
  }

  async request(path: string, { method = "POST", body, signal }: WechatRequestOptions = {}): Promise<WechatApiResponse> {
    return retry(
      async (bail) => {
        try {
          const response = await axios.request({
            url: `${this.baseUrl}/${path.replace(/^\/+/, "")}`,
            method,
            headers: this.headers(),
            data: body,
            signal,
            timeout: 30_000,
            validateStatus: () => true,
          });

          if (response.status >= 400 && response.status < 500) {
            bail(new Error(`Wechat HTTP ${response.status} ${response.statusText}`));
            return;
          }
          if (response.status >= 500) {
            throw new Error(`Wechat HTTP ${response.status} ${response.statusText}`);
          }

          const data = WechatResponseSchema.parse(response.data);
          if (data.errcode === -14) {
            bail(new Error("Wechat session expired; please login again."));
            return;
          }
          if (data.ret !== undefined && data.ret !== 0) {
            bail(new Error(data.errmsg || String(data.msg || "") || `Wechat API ret=${data.ret}`));
            return;
          }
          return data;
        } catch (error) {
          if (
            axios.isCancel(error) ||
            (error instanceof Error && error.name === "AbortError") ||
            (error && typeof error === "object" && "code" in error && error.code === "ERR_CANCELED")
          ) {
            bail(error);
            return;
          }
          throw error;
        }
      },
      {
        retries: 2,
        minTimeout: 500,
        maxTimeout: 2_000,
      },
    );
  }

  async login() {
    this.onLog(color.yellow("Requesting Wechat login QR code..."));
    const qr = await this.request("ilink/bot/get_bot_qrcode?bot_type=3", { method: "GET" });
    const qrTicket = String(qr.qrcode || "");
    const qrDisplayValue = String(qr.qrcode_img_content || qr.url || qr.qrcode_url || "");

    if (!qrTicket) {
      throw new Error("Wechat login response did not include qrcode ticket.");
    }

    if (qrDisplayValue) {
      this.onLog("Scan this Wechat login QR:");
      this.onLog(renderQr(qrDisplayValue));
    } else {
      this.onLog(
        color.yellow("Wechat did not return qrcode_img_content. Showing the raw login ticket as a fallback."),
      );
      this.onLog(qrTicket);
    }

    const startedAt = Date.now();
    while (Date.now() - startedAt < 120_000) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const status = await this.request(
        `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrTicket)}`,
        { method: "GET" },
      );

      if (status.status === "confirmed") {
        this.token = String(status.bot_token || "");
        this.baseUrl = String(status.baseurl || this.baseUrl);
        this.enabled = true;
        this.onLog(color.green("Wechat login confirmed"));
        this.emitChange();
        this.start();
        return;
      }

      this.onLog(`Wechat login status: ${status.status || "waiting"}`);
    }

    throw new Error("Wechat login timed out.");
  }

  chatTargetForRoute(route?: WechatTargetRoute) {
    return {
      chatId: String(route?.target?.chatId || this.chatId || "").trim(),
      contextToken: String(route?.target?.contextToken || this.contextToken || "").trim(),
    };
  }

  async send(text: string, route?: WechatTargetRoute) {
    const target = this.chatTargetForRoute(route);
    if (!this.enabled || !this.token || !target.chatId || !target.contextToken) {
      return;
    }

    try {
      await this.request("ilink/bot/sendmessage", {
        body: {
            msg: {
            from_user_id: "",
            to_user_id: target.chatId,
            client_id: crypto.randomUUID(),
            message_type: 2,
            message_state: 2,
            context_token: target.contextToken,
            item_list: [{ type: 1, text_item: { text } }],
          },
          base_info: { channel_version: CHANNEL_VERSION },
        },
      });
    } catch (error) {
      this.onLog(color.red(`Wechat send failed: ${errorMessage(error)}`));
    }
  }

  async sendTask(payload: ChatPayload, route?: WechatTargetRoute) {
    await this.send(renderPlainChatPayload(payload), route);
  }

  async sendApprovalPayload(payload: ChatPayload, route?: WechatTargetRoute) {
    await this.send(renderPlainChatPayload(payload), route);
  }

  bind({ token, baseUrl, chatId, contextToken, updatesBuf }: Partial<WechatBridgeOptions>) {
    this.stop();
    this.token = token || this.token;
    this.baseUrl = baseUrl || this.baseUrl;
    this.chatId = chatId || this.chatId;
    this.contextToken = contextToken || this.contextToken;
    this.updatesBuf = updatesBuf || this.updatesBuf || "";
    this.enabled = Boolean(this.token);
    this.onLog(color.green("Wechat binding updated"));
    this.emitChange();
    if (this.enabled) {
      this.start();
    }
  }

  setChat(chatId: string) {
    this.chatId = chatId;
    this.onLog(color.green(`Wechat chat set: ${chatId}`));
    this.emitChange();
  }

  setContext(contextToken: string) {
    this.contextToken = contextToken;
    this.onLog(color.green("Wechat context token set"));
    this.emitChange();
  }

  unbind() {
    this.stop();
    this.token = undefined;
    this.chatId = undefined;
    this.contextToken = undefined;
    this.updatesBuf = "";
    this.onLog(color.green("Wechat binding removed"));
    this.emitChange();
  }

  stop() {
    this.enabled = false;
    this.polling = false;
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = undefined;
    }
  }

  start() {
    if (!this.token) {
      this.onLog(color.yellow("Wechat token is not set. Use /wechat login or /wechat bind <token>."));
      return;
    }
    if (this.polling) {
      return;
    }

    this.enabled = true;
    this.polling = true;
    this.pollLoop();
    this.onLog(color.green("Wechat polling enabled"));
  }

  async pollLoop() {
    while (this.enabled && this.token) {
      this.abortController = new AbortController();
      try {
        const data = await this.request("ilink/bot/getupdates", {
          body: {
            get_updates_buf: this.updatesBuf,
            base_info: { channel_version: CHANNEL_VERSION },
          },
          signal: this.abortController.signal,
        });
        this.updatesBuf = String(data.get_updates_buf ?? this.updatesBuf);
        this.emitChange();

        const messages = Array.isArray(data.msgs) ? data.msgs : [];
        for (const message of messages) {
          if (isWechatWireMessage(message)) {
            this.handleMessage(message);
          }
        }
      } catch (error) {
        if (this.enabled) {
          this.onLog(color.red(`Wechat polling failed: ${errorMessage(error)}`));
          await new Promise((resolve) => setTimeout(resolve, 3000));
        }
      }
    }
    this.polling = false;
  }

  handleMessage(message: WechatWireMessage) {
    if (message.message_type !== 1) {
      return;
    }

    const text = textFromMessage(message);
    if (!text) {
      return;
    }

    const chatId = message.from_user_id;
    if (!this.chatId) {
      this.chatId = chatId;
      this.onLog(color.green(`Wechat chat bound: ${this.chatId}`));
      if (!this.multiChat) {
        this.contextToken = message.context_token || this.contextToken;
        this.emitChange();
        return;
      }
    }
    if (!this.multiChat || this.chatId === chatId) {
      this.contextToken = message.context_token || this.contextToken;
    }
    this.emitChange();

    if (!this.multiChat && this.chatId !== chatId) {
      return;
    }

    this.onText(text, { chatId, contextToken: message.context_token });
  }
}

export { WechatBridge };
