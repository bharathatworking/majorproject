copy this in powershell
[System.Environment]::SetEnvironmentVariable("OLLAMA_ORIGINS", "chrome-extension://emnnfgmpahidhdpdakmblphimmamckon", "User")
[System.Environment]::GetEnvironmentVariable("OLLAMA_ORIGINS", "User")
