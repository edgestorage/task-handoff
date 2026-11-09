//! Explicit owned-fixture input diagnostic. Requires the fixture PID to remain
//! frontmost before each request; never logs text or targets a user application.
#[cfg(target_os = "macos")]
#[tokio::main]
async fn main() -> anyhow::Result<()> {
    use desktop_streaming::{
        channel::{Button, Input, Key, Pointer, Text},
        input_guard::{Backend, Client, Command, Event},
        traits::Geometry,
    };
    use std::{io::Write, time::Duration};
    let args: Vec<_> = std::env::args().skip(1).collect();
    anyhow::ensure!(args.len() == 4, "expected action x y owned-fixture-pid");
    let action = &args[0];
    anyhow::ensure!(
        [
            "click",
            "text",
            "watchdog-key",
            "hold-key",
            "hold-button",
            "key"
        ]
        .contains(&action.as_str()),
        "invalid action"
    );
    let x: f64 = args[1].parse()?;
    let y: f64 = args[2].parse()?;
    let pid: i32 = args[3].parse()?;
    let focused = || -> anyhow::Result<()> {
        anyhow::ensure!(
            pid > 0
                && objc2_app_kit::NSWorkspace::sharedWorkspace()
                    .frontmostApplication()
                    .is_some_and(|app| app.processIdentifier() == pid),
            "owned fixture lost focus"
        );
        Ok(())
    };
    focused()?;
    let rect = core_graphics::display::CGDisplay::main().bounds();
    let geometry = Geometry::from_actuator_rect(
        rect.origin.x,
        rect.origin.y,
        rect.size.width,
        rect.size.height,
    )?;
    let binary = std::env::current_exe()?.with_file_name("task-handoff-desktop-streaming");
    let mut guard = Client::spawn(
        &binary,
        Backend::Native {
            geometry,
            display: None,
            authority: None,
        },
    )
    .await?;
    guard.call(&Command::Arm { epoch: 1 }).await?;
    let event = match action.as_str() {
        "text" => Input::Text(Text {
            input_epoch: 1,
            text: "中文・日本語・é・😀 mixed ASCII punctuation !?".into(),
        }),
        "hold-button" => Input::Button(Button {
            input_epoch: 1,
            x,
            y,
            button: 0,
            down: true,
        }),
        "click" => {
            focused()?;
            guard
                .call(&Command::Pointer {
                    event: Pointer {
                        input_epoch: 1,
                        x,
                        y,
                    },
                })
                .await?;
            focused()?;
            guard
                .call(&Command::Input {
                    event: Input::Button(Button {
                        input_epoch: 1,
                        x,
                        y,
                        button: 0,
                        down: true,
                    }),
                })
                .await?;
            tokio::time::sleep(Duration::from_millis(30)).await;
            Input::Button(Button {
                input_epoch: 1,
                x,
                y,
                button: 0,
                down: false,
            })
        }
        _ => Input::Key(Key {
            input_epoch: 1,
            code: "KeyA".into(),
            down: true,
            modifiers: 0,
            repeat: false,
        }),
    };
    focused()?;
    guard.call(&Command::Input { event }).await?;
    if action == "hold-key" || action == "hold-button" {
        println!(
            "{}",
            serde_json::json!({"held":true,"guardPid":guard.child.id()})
        );
        std::io::stdout().flush()?;
        tokio::time::sleep(Duration::from_secs(10)).await;
    } else if action == "watchdog-key" {
        tokio::time::sleep(Duration::from_millis(1700)).await;
        anyhow::ensure!(
            matches!(
                guard.call(&Command::Probe).await?,
                Event::State { epoch: None, .. }
            ),
            "guard lease did not expire"
        );
    } else if action == "key" {
        focused()?;
        guard
            .call(&Command::Input {
                event: Input::Key(Key {
                    input_epoch: 1,
                    code: "KeyA".into(),
                    down: false,
                    modifiers: 0,
                    repeat: false,
                }),
            })
            .await?;
    }
    guard.close().await?;
    println!("{}", serde_json::json!({"ok":true,"action":action}));
    Ok(())
}
#[cfg(not(target_os = "macos"))]
fn main() -> anyhow::Result<()> {
    anyhow::bail!("macOS owned-fixture diagnostic only")
}
