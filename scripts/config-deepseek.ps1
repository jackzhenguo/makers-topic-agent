chcp 65001 > $null
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new()
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
$OutputEncoding = [System.Text.UTF8Encoding]::new()

$secureKey = Read-Host "Enter EdgeOne AI Gateway API Key (hidden input)" -AsSecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)

try {
  $apiKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
}

if ([string]::IsNullOrWhiteSpace($apiKey)) {
  Write-Error "API Key is empty. .env was not written."
  exit 1
}

$envPath = Join-Path (Get-Location) ".env"
$content = @"
ANTHROPIC_API_KEY=$apiKey
ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic
ANTHROPIC_MODEL=claude-sonnet-4-20250514
"@

[System.IO.File]::WriteAllText($envPath, $content, [System.Text.UTF8Encoding]::new($false))
Write-Host ".env written. DeepSeek Anthropic API maps claude-sonnet to deepseek-v4-flash."
Write-Host "Next: npm run dev:win -- `"your prompt here`""
