import { z } from "zod";

/**
 * 调用方为一次写请求自造的一次性幂等/关联键。
 *
 * 它不是实体 ID：服务端只把它当不透明字符串使用，也不经统一 ID 铸造函数生成，
 * 因此除传输长度上界外不做形状约束。所有接收该字段的边界都必须复用这里的声明，
 * 避免各端点各写一份、约束漂移。
 */
export const CLIENT_REQUEST_ID_MAX_LENGTH = 160;

export const ClientRequestIdSchema = z.string().trim().min(1).max(CLIENT_REQUEST_ID_MAX_LENGTH);

/**
 * 增量兼容态：只用于旧实例尚不接受该字段的边界（见各处的 Compatibility 注释）。
 */
export const OptionalClientRequestIdSchema = ClientRequestIdSchema.optional();

export type ClientRequestId = z.infer<typeof ClientRequestIdSchema>;
