mod agent;

use agent::AgentRegistry;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AgentRegistry::default())
        .invoke_handler(tauri::generate_handler![
            agent::agent_spawn,
            agent::agent_send,
            agent::agent_interrupt,
            agent::agent_kill,
            agent::agent_kill_all,
            agent::devlog,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
