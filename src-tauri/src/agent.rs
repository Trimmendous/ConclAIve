//! Harness-neutral process supervisor for council personas.
//!
//! Each persona owns a conversation session, while each turn is one native
//! non-interactive CLI invocation. Codex uses `exec`/`exec resume`, OpenCode
//! uses `run`/`--session`, and Claude Code uses print mode/`--resume`.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdout, Command, Stdio};
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, State};

const CLAUDE_DENIED: &str = "Task,Artifact,Bash,Write,Edit,NotebookEdit,WebSearch,WebFetch,Skill,\
ToolSearch,SendMessage,Monitor,CronCreate,CronDelete,CronList,DesignSync,EnterWorktree,\
ExitWorktree,ListAgents,PushNotification,RemoteTrigger,ReportFindings,ScheduleWakeup,TaskOutput,\
TaskStop";

const EFFORTS: [&str; 5] = ["low", "medium", "high", "xhigh", "max"];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Harness {
    Codex,
    OpenCode,
    ClaudeCode,
}

impl Harness {
    fn parse(value: &str) -> Result<Self, String> {
        match value {
            "codex" => Ok(Self::Codex),
            "opencode" => Ok(Self::OpenCode),
            "claude-code" => Ok(Self::ClaudeCode),
            _ => Err(format!("unknown AI harness: {value}")),
        }
    }

    fn executable(self) -> &'static str {
        match self {
            Self::Codex => "codex",
            Self::OpenCode => "opencode",
            Self::ClaudeCode => "claude",
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Codex => "Codex",
            Self::OpenCode => "OpenCode",
            Self::ClaudeCode => "Claude Code",
        }
    }
}

struct AgentState {
    harness: Harness,
    system_prompt: String,
    model: String,
    codebase_dir: Option<PathBuf>,
    effort: String,
    session_id: Option<String>,
    child: Option<Child>,
    turn_seq: u64,
    interrupted: bool,
    suppress_end: bool,
    last_error: String,
}

#[derive(Default)]
pub struct AgentRegistry(Mutex<HashMap<String, Arc<Mutex<AgentState>>>>);

fn valid_agent_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn valid_model(model: &str) -> bool {
    !model.is_empty()
        && model.len() <= 160
        && model
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "-._/:@".contains(c))
}

/// Desktop apps do not always inherit the interactive shell's PATH. Check it
/// first, then the common per-user CLI install locations.
fn executable_path(name: &str) -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path) {
            let candidate = dir.join(name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }

    let home = std::env::var_os("HOME").map(PathBuf::from)?;
    for relative in [".local/bin", ".npm-global/bin", ".bun/bin"] {
        let candidate = home.join(relative).join(name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

fn checked_codebase(value: Option<String>) -> Result<Option<PathBuf>, String> {
    match value.filter(|s| !s.trim().is_empty()) {
        Some(value) => {
            let path = PathBuf::from(&value);
            if !path.is_dir() {
                return Err(format!("codebase directory does not exist: {value}"));
            }
            Ok(Some(path))
        }
        None => Ok(None),
    }
}

#[tauri::command]
pub fn agent_spawn(
    registry: State<'_, AgentRegistry>,
    agent_id: String,
    harness: String,
    system_prompt: String,
    model: String,
    codebase_dir: Option<String>,
    effort: Option<String>,
) -> Result<(), String> {
    if !valid_agent_id(&agent_id) {
        return Err(format!("invalid agent id: {agent_id}"));
    }
    if !valid_model(&model) {
        return Err(format!("invalid model id: {model}"));
    }

    let harness = Harness::parse(&harness)?;
    if executable_path(harness.executable()).is_none() {
        return Err(format!(
            "{} CLI is not installed or was not found on PATH (expected `{}`)",
            harness.label(),
            harness.executable()
        ));
    }

    let effort = effort.unwrap_or_else(|| "medium".to_string());
    if !EFFORTS.contains(&effort.as_str()) {
        return Err(format!("unknown effort level: {effort}"));
    }

    let state = AgentState {
        harness,
        system_prompt,
        model,
        codebase_dir: checked_codebase(codebase_dir)?,
        effort,
        session_id: None,
        child: None,
        turn_seq: 0,
        interrupted: false,
        suppress_end: false,
        last_error: String::new(),
    };

    let mut map = registry.0.lock().map_err(|_| "registry lock poisoned")?;
    if map.contains_key(&agent_id) {
        return Err(format!("agent already running: {agent_id}"));
    }
    map.insert(agent_id, Arc::new(Mutex::new(state)));
    Ok(())
}

fn first_prompt(system_prompt: &str, message: &str) -> String {
    format!(
        "{system_prompt}\n\nThe system instructions above define your role for this conversation.\n\nChair message:\n{message}"
    )
}

fn command_for(state: &AgentState, message: &str) -> Result<Command, String> {
    let exe = executable_path(state.harness.executable())
        .ok_or_else(|| format!("{} CLI disappeared from PATH", state.harness.label()))?;
    Ok(command_with_exe(&exe, state, message))
}

fn command_with_exe(exe: &Path, state: &AgentState, message: &str) -> Command {
    let initial = state.session_id.is_none();
    let prompt = if initial {
        first_prompt(&state.system_prompt, message)
    } else {
        message.to_string()
    };
    let mut cmd = Command::new(exe);

    match state.harness {
        Harness::Codex => {
            cmd.arg("exec");
            if let Some(session) = &state.session_id {
                cmd.args(["resume", session]);
                // Resume inherits the sandbox and working root from the
                // persisted thread. The resume subcommand does not accept
                // `--sandbox` or `--color`.
                cmd.args(["--json", "--skip-git-repo-check", "--ignore-rules"]);
            } else {
                cmd.args(["--json", "--color", "never", "--sandbox", "read-only"])
                    .arg("--skip-git-repo-check")
                    .arg("--ignore-rules");
            }
            cmd.args(["--model", &state.model])
                .args([
                    "-c",
                    &format!("model_reasoning_effort=\"{}\"", state.effort),
                ])
                // `-` is Codex's explicit "read prompt from stdin" form.
                // Positional prompts make a GUI process's non-terminal stdin
                // produce a misleading notice for every council member.
                .arg("-");
        }
        Harness::OpenCode => {
            cmd.args(["run", "--format", "json", "--model", &state.model]);
            if let Some(session) = &state.session_id {
                cmd.args(["--session", session]);
            }
            if state.effort != "medium" {
                cmd.args(["--variant", &state.effort]);
            }
            cmd.arg(prompt);

            // Inline config has the highest ordinary precedence. Discussion
            // mode gets no tools; codebase mode permits only read/search.
            let permissions = if state.codebase_dir.is_some() {
                json!({
                    "permission": {
                        "*": "deny", "read": "allow", "glob": "allow",
                        "grep": "allow", "list": "allow"
                    },
                    "mcp": {}, "plugin": []
                })
            } else {
                json!({ "permission": "deny", "mcp": {}, "plugin": [] })
            };
            cmd.env("OPENCODE_CONFIG_CONTENT", permissions.to_string());
        }
        Harness::ClaudeCode => {
            cmd.arg("-p")
                .args(["--output-format", "stream-json"])
                .arg("--verbose")
                .arg("--include-partial-messages")
                .args(["--system-prompt", &state.system_prompt])
                .args(["--model", &state.model])
                .args(["--effort", &state.effort])
                .arg("--disable-slash-commands")
                .args(["--setting-sources", ""])
                .arg("--strict-mcp-config");
            if let Some(session) = &state.session_id {
                cmd.args(["--resume", session]);
            }
            if state.codebase_dir.is_some() {
                cmd.args(["--allowedTools", "Read,Glob,Grep"])
                    .args(["--permission-mode", "dontAsk"])
                    .args(["--disallowed-tools", CLAUDE_DENIED]);
            } else {
                cmd.args(["--tools", ""]);
            }
            cmd.arg(message);
        }
    }

    if let Some(dir) = &state.codebase_dir {
        cmd.current_dir(dir);
    }

    if state.harness == Harness::Codex {
        cmd.stdin(Stdio::piped());
    } else {
        cmd.stdin(Stdio::null());
    }
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    cmd
}

#[tauri::command]
pub fn agent_send(
    app: AppHandle,
    registry: State<'_, AgentRegistry>,
    agent_id: String,
    text: String,
) -> Result<(), String> {
    let shared = {
        let map = registry.0.lock().map_err(|_| "registry lock poisoned")?;
        map.get(&agent_id)
            .cloned()
            .ok_or_else(|| format!("no such agent: {agent_id}"))?
    };

    let (harness, stdout, stderr, turn_seq) = {
        let mut state = shared.lock().map_err(|_| "agent state lock poisoned")?;
        if let Some(child) = state.child.as_mut() {
            if child.try_wait().map_err(|e| e.to_string())?.is_none() {
                return Err(format!("{} is already answering", state.harness.label()));
            }
            state.child.take();
        }

        let stdin_payload = if state.harness == Harness::Codex {
            Some(if state.session_id.is_none() {
                first_prompt(&state.system_prompt, &text)
            } else {
                text.clone()
            })
        } else {
            None
        };
        let mut child = command_for(&state, &text)?
            .spawn()
            .map_err(|e| format!("failed to launch {}: {e}", state.harness.label()))?;
        if let Some(payload) = stdin_payload {
            let write_result = match child.stdin.take() {
                Some(mut stdin) => stdin
                    .write_all(payload.as_bytes())
                    .map_err(|e| e.to_string()),
                None => Err("child stdin unavailable".to_string()),
            };
            if let Err(error) = write_result {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("failed to send prompt to Codex: {error}"));
            }
        }
        let stdout = child.stdout.take().ok_or("child stdout unavailable")?;
        let stderr = child.stderr.take();
        state.turn_seq += 1;
        state.interrupted = false;
        state.suppress_end = false;
        state.last_error.clear();
        let seq = state.turn_seq;
        let harness = state.harness;
        state.child = Some(child);
        (harness, stdout, stderr, seq)
    };

    spawn_stdout_reader(
        app.clone(),
        agent_id.clone(),
        harness,
        stdout,
        shared.clone(),
        turn_seq,
    );
    if let Some(stderr) = stderr {
        spawn_stderr_reader(app, agent_id, stderr, shared, turn_seq);
    }
    Ok(())
}

fn string_at<'a>(value: &'a Value, paths: &[&[&str]]) -> Option<&'a str> {
    paths.iter().find_map(|path| {
        let mut current = value;
        for key in *path {
            current = current.get(*key)?;
        }
        current.as_str()
    })
}

fn session_id(value: &Value) -> Option<&str> {
    string_at(
        value,
        &[
            &["thread_id"],
            &["session_id"],
            &["sessionID"],
            &["part", "sessionID"],
            &["message", "sessionID"],
        ],
    )
}

fn event_text(harness: Harness, value: &Value) -> Option<&str> {
    match harness {
        Harness::ClaudeCode => {
            if value.get("type").and_then(Value::as_str) == Some("stream_event")
                && value["event"].get("type").and_then(Value::as_str) == Some("content_block_delta")
            {
                value["event"]["delta"].get("text").and_then(Value::as_str)
            } else {
                None
            }
        }
        Harness::Codex => {
            let item = value.get("item")?;
            if value.get("type").and_then(Value::as_str) == Some("item.completed")
                && item.get("type").and_then(Value::as_str) == Some("agent_message")
            {
                item.get("text").and_then(Value::as_str)
            } else {
                None
            }
        }
        Harness::OpenCode => {
            if value.get("type").and_then(Value::as_str) == Some("text") {
                string_at(value, &[&["part", "text"], &["text"]])
            } else {
                None
            }
        }
    }
}

fn tool_event(harness: Harness, value: &Value) -> Option<(String, String)> {
    match harness {
        Harness::ClaudeCode => {
            if value.get("type").and_then(Value::as_str) != Some("assistant") {
                return None;
            }
            let block = value["message"]["content"]
                .as_array()?
                .iter()
                .find(|b| b.get("type").and_then(Value::as_str) == Some("tool_use"))?;
            Some((
                block
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or("tool")
                    .to_string(),
                tool_detail(&block["input"]),
            ))
        }
        Harness::Codex => {
            let item = value.get("item")?;
            let kind = item.get("type").and_then(Value::as_str)?;
            if !matches!(kind, "command_execution" | "mcp_tool_call" | "file_change") {
                return None;
            }
            Some((
                kind.replace('_', " "),
                string_at(item, &[&["command"], &["server"], &["path"]])
                    .unwrap_or("")
                    .to_string(),
            ))
        }
        Harness::OpenCode => {
            let kind = value.get("type").and_then(Value::as_str)?;
            if !matches!(kind, "tool" | "tool_use" | "tool-call") {
                return None;
            }
            Some((
                string_at(value, &[&["part", "tool"], &["name"]])
                    .unwrap_or("tool")
                    .to_string(),
                string_at(
                    value,
                    &[
                        &["part", "state", "input", "filePath"],
                        &["part", "state", "input", "pattern"],
                    ],
                )
                .unwrap_or("")
                .to_string(),
            ))
        }
    }
}

fn token_usage(harness: Harness, value: &Value) -> Option<(u64, u64, u64)> {
    let usage = match harness {
        Harness::Codex if value.get("type").and_then(Value::as_str) == Some("turn.completed") => {
            value.get("usage")?
        }
        Harness::ClaudeCode if value.get("type").and_then(Value::as_str) == Some("result") => {
            value.get("usage")?
        }
        Harness::OpenCode => value.get("part")?.get("tokens")?,
        _ => return None,
    };

    let input = usage
        .get("input_tokens")
        .or_else(|| usage.get("input"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let cached = usage
        .get("cached_input_tokens")
        .or_else(|| usage.get("cache_read_input_tokens"))
        .or_else(|| usage.get("cache").and_then(|cache| cache.get("read")))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let output = usage
        .get("output_tokens")
        .or_else(|| usage.get("output"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    Some((input, cached, output))
}

fn spawn_stdout_reader(
    app: AppHandle,
    agent_id: String,
    harness: Harness,
    stdout: ChildStdout,
    shared: Arc<Mutex<AgentState>>,
    turn_seq: u64,
) {
    std::thread::spawn(move || {
        let mut accumulated = String::new();
        let mut cost_usd = 0.0;
        let mut input_tokens = 0;
        let mut cached_input_tokens = 0;
        let mut output_tokens = 0;
        let mut result_error = false;
        let mut result_interrupted = false;

        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            let Ok(value) = serde_json::from_str::<Value>(&line) else {
                continue;
            };

            if let Some(id) = session_id(&value) {
                if let Ok(mut state) = shared.lock() {
                    if state.turn_seq == turn_seq {
                        state.session_id = Some(id.to_string());
                    }
                }
            }
            if let Some(text) = event_text(harness, &value) {
                accumulated.push_str(text);
                let _ = app.emit(
                    "council://delta",
                    json!({ "agent_id": agent_id, "text": text }),
                );
            }
            if let Some((name, detail)) = tool_event(harness, &value) {
                let _ = app.emit(
                    "council://tool",
                    json!({ "agent_id": agent_id, "name": name, "detail": detail }),
                );
            }
            if let Some((input, cached, output)) = token_usage(harness, &value) {
                input_tokens += input;
                cached_input_tokens += cached;
                output_tokens += output;
            }

            if harness == Harness::ClaudeCode
                && value.get("type").and_then(Value::as_str) == Some("result")
            {
                if accumulated.is_empty() {
                    accumulated = value
                        .get("result")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string();
                }
                cost_usd = value
                    .get("total_cost_usd")
                    .and_then(Value::as_f64)
                    .unwrap_or(0.0);
                result_error = value
                    .get("is_error")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                result_interrupted =
                    value.get("subtype").and_then(Value::as_str) == Some("error_during_execution");
            }
            if harness == Harness::OpenCode {
                cost_usd += value
                    .get("part")
                    .and_then(|p| p.get("cost"))
                    .and_then(Value::as_f64)
                    .unwrap_or(0.0);
            }
        }

        let (interrupted, suppress, failed, last_error) = match shared.lock() {
            Ok(mut state) if state.turn_seq == turn_seq => {
                let interrupted = state.interrupted || result_interrupted;
                let suppress = state.suppress_end;
                let last_error = state.last_error.clone();
                let failed = state
                    .child
                    .take()
                    .and_then(|mut child| child.wait().ok())
                    .is_some_and(|status| !status.success());
                (interrupted, suppress, failed || result_error, last_error)
            }
            _ => return,
        };

        if suppress {
            return;
        }
        if accumulated.is_empty() && !last_error.is_empty() {
            accumulated = format!("[{}]", last_error);
        }
        let _ = app.emit(
            "council://turn_end",
            json!({
                "agent_id": agent_id,
                "text": accumulated,
                "cost_usd": cost_usd,
                "input_tokens": input_tokens,
                "cached_input_tokens": cached_input_tokens,
                "output_tokens": output_tokens,
                "interrupted": interrupted,
                "is_error": failed && !interrupted,
            }),
        );
    });
}

fn tool_detail(input: &Value) -> String {
    for key in ["file_path", "pattern", "path", "command"] {
        if let Some(value) = input.get(key).and_then(Value::as_str) {
            return value.to_string();
        }
    }
    String::new()
}

fn spawn_stderr_reader(
    app: AppHandle,
    agent_id: String,
    stderr: std::process::ChildStderr,
    shared: Arc<Mutex<AgentState>>,
    turn_seq: u64,
) {
    std::thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            let message = line.trim();
            if message.is_empty() || benign_cli_notice(message) {
                continue;
            }
            if let Ok(mut state) = shared.lock() {
                if state.turn_seq == turn_seq {
                    state.last_error = message.to_string();
                }
            }
            let _ = app.emit(
                "council://error",
                json!({ "agent_id": agent_id, "message": message }),
            );
        }
    });
}

fn benign_cli_notice(message: &str) -> bool {
    matches!(
        message,
        "Reading prompt from stdin..." | "Reading additional input from stdin..."
    ) || message.starts_with("WARNING: proceeding, even though we could not create PATH aliases:")
}

#[tauri::command]
pub fn agent_interrupt(registry: State<'_, AgentRegistry>, agent_id: String) -> Result<(), String> {
    let shared = {
        let map = registry.0.lock().map_err(|_| "registry lock poisoned")?;
        map.get(&agent_id)
            .cloned()
            .ok_or_else(|| format!("no such agent: {agent_id}"))?
    };
    let mut state = shared.lock().map_err(|_| "agent state lock poisoned")?;
    state.interrupted = true;
    if let Some(child) = state.child.as_mut() {
        child.kill().map_err(|e| format!("interrupt failed: {e}"))?;
    }
    Ok(())
}

fn stop_agent(shared: Arc<Mutex<AgentState>>) {
    if let Ok(mut state) = shared.lock() {
        state.suppress_end = true;
        if let Some(mut child) = state.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

#[tauri::command]
pub fn agent_kill(registry: State<'_, AgentRegistry>, agent_id: String) -> Result<(), String> {
    let shared = registry
        .0
        .lock()
        .map_err(|_| "registry lock poisoned")?
        .remove(&agent_id);
    if let Some(shared) = shared {
        stop_agent(shared);
    }
    Ok(())
}

#[tauri::command]
pub fn agent_kill_all(registry: State<'_, AgentRegistry>) -> Result<(), String> {
    let agents: Vec<_> = registry
        .0
        .lock()
        .map_err(|_| "registry lock poisoned")?
        .drain()
        .map(|(_, state)| state)
        .collect();
    for state in agents {
        stop_agent(state);
    }
    Ok(())
}

#[tauri::command]
pub fn devlog(message: String) {
    eprintln!("[devlog] {message}");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state(harness: Harness) -> AgentState {
        AgentState {
            harness,
            system_prompt: "You are a careful reviewer.".into(),
            model: "test/model-1".into(),
            codebase_dir: None,
            effort: "high".into(),
            session_id: None,
            child: None,
            turn_seq: 0,
            interrupted: false,
            suppress_end: false,
            last_error: String::new(),
        }
    }

    fn args(command: &Command) -> Vec<String> {
        command
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect()
    }

    #[test]
    fn harness_names_are_explicit() {
        assert_eq!(Harness::parse("codex"), Ok(Harness::Codex));
        assert_eq!(Harness::parse("opencode"), Ok(Harness::OpenCode));
        assert_eq!(Harness::parse("claude-code"), Ok(Harness::ClaudeCode));
        assert!(Harness::parse("claude").is_err());
    }

    #[test]
    fn model_ids_allow_provider_paths_but_not_shell_syntax() {
        assert!(valid_model("openai/gpt-5.6-terra"));
        assert!(valid_model("anthropic:claude-sonnet@latest"));
        assert!(!valid_model("model; touch /tmp/nope"));
    }

    #[test]
    fn codex_resume_uses_supported_resume_flags() {
        let first = state(Harness::Codex);
        let first_args = args(&command_with_exe(Path::new("/bin/codex"), &first, "hello"));
        assert!(first_args
            .windows(2)
            .any(|a| a == ["--sandbox", "read-only"]));
        assert_eq!(first_args.last().map(String::as_str), Some("-"));

        let mut resumed = state(Harness::Codex);
        resumed.session_id = Some("thread-123".into());
        let resumed_args = args(&command_with_exe(
            Path::new("/bin/codex"),
            &resumed,
            "continue",
        ));
        assert_eq!(&resumed_args[..3], ["exec", "resume", "thread-123"]);
        assert!(!resumed_args.iter().any(|arg| arg == "--sandbox"));
        assert!(resumed_args.iter().any(|arg| arg == "--json"));
        assert_eq!(resumed_args.last().map(String::as_str), Some("-"));
    }

    #[test]
    fn parses_each_harness_text_event() {
        let codex = json!({"type":"item.completed","item":{"type":"agent_message","text":"c"}});
        let open = json!({"type":"text","part":{"text":"o"}});
        let claude = json!({"type":"stream_event","event":{"type":"content_block_delta","delta":{"text":"a"}}});
        assert_eq!(event_text(Harness::Codex, &codex), Some("c"));
        assert_eq!(event_text(Harness::OpenCode, &open), Some("o"));
        assert_eq!(event_text(Harness::ClaudeCode, &claude), Some("a"));
    }

    #[test]
    fn ignores_known_non_error_cli_notices() {
        assert!(benign_cli_notice("Reading prompt from stdin..."));
        assert!(benign_cli_notice("Reading additional input from stdin..."));
        assert!(benign_cli_notice(
            "WARNING: proceeding, even though we could not create PATH aliases: read-only"
        ));
        assert!(!benign_cli_notice("authentication failed"));
    }

    #[test]
    fn parses_codex_usage_without_inventing_a_price() {
        let event = json!({
            "type": "turn.completed",
            "usage": {"input_tokens": 120, "cached_input_tokens": 80, "output_tokens": 30}
        });
        assert_eq!(token_usage(Harness::Codex, &event), Some((120, 80, 30)));
    }
}
