---

## Download

| File | For |
|---|---|
| **Ccboat_{version}_x64-setup.exe** | Windows 10 and 11, 64-bit |

Run the installer. It installs for your Windows user only (no administrator rights) into
`%LOCALAPPDATA%\Ccboat`. A newer installer upgrades in place; your settings are kept.

Ccboat reads the sessions Claude Code keeps in `%USERPROFILE%\.claude` (or `CLAUDE_CONFIG_DIR`). It
never writes there and never uses the network.

> [!NOTE]
> The installer isn't code-signed yet, so SmartScreen may show "Windows protected your PC": click
> **More info**, then **Run anyway**. You can check the file is the one built here with its SHA-256
> checksum below. A macOS build will follow.

**SHA-256** (also in `SHA256SUMS.txt`):

```
{sha256}  Ccboat_{version}_x64-setup.exe
```

Check it in PowerShell: `(Get-FileHash .\Ccboat_{version}_x64-setup.exe).Hash`.

**Requirements:** Windows 10 or 11, 64-bit, with Microsoft Edge WebView2 (built into Windows 11; on
Windows 10 the installer downloads it if it's missing), and Claude Code.

**Uninstall:** Settings > Apps > Ccboat.

This build was made by GitHub Actions from the source code at tag `v{version}`.
Full history: [CHANGELOG.md](https://github.com/{repo}/blob/v{version}/CHANGELOG.md).
