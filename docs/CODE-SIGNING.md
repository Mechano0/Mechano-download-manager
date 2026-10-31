# Code signing

Windows SmartScreen shows "Windows protected your PC" for programs that are not signed or have little reputation.
Signing `Mechano DM Setup.exe` (and the exes inside it) removes the "Unknown publisher" warning. A signed program
still has to collect reputation for a while before SmartScreen stops warning completely.

Signing is **optional**. Without a certificate the build works exactly as before.

## Option 1: SignPath Foundation (free for open-source projects)

SignPath Foundation signs releases of open-source projects for free. The certificate is in the name of
SignPath Foundation, and the project page names Mechano DM as the signed project.

What they ask for (check the current rules on signpath.org before applying):
- An OSI-approved license in the repository and a public repository.
- The release is built by a CI system (GitHub Actions), so they can check that the signed file came from the source code.
- A short description of the project and who maintains it.

Steps:
1. Apply on the SignPath Foundation page (signpath.org → open source). Use the GitHub repository link.
2. After approval you get an organization, a project and a signing policy in SignPath.
3. Add a GitHub Actions workflow that runs `build-setup.ps1 -Rebuild` on a Windows runner, uploads
   `dist\Mechano DM Setup.exe` as an artifact, and sends it to SignPath with their GitHub action
   (`signpath/github-action-submit-signing-request`). Keep the SignPath API token in a repository secret.
4. Download the signed Setup.exe from the action, then run `node tools/sign-release.js` on that file
   (the update signature must be made **after** code signing, because signing changes the file).

## Option 2: your own certificate

If you buy a code-signing certificate (or use Azure Trusted Signing), install it on this PC and build with its thumbprint:

```bash
powershell -File build-setup.ps1 -Rebuild -SignThumbprint <thumbprint>
```

You can also set the environment variable `MDM_SIGN_THUMBPRINT` instead of passing the parameter.

The script finds `signtool.exe` in the Windows SDK (install "Windows SDK Signing Tools"), signs `Mechano DM.exe`
before it is packed, then `Uninstall.exe` and `Setup.exe`, with SHA-256 and a timestamp from DigiCert.

## Order of a signed release

1. Bump the version in `package.json`.
2. Build and code-sign (`build-setup.ps1 -Rebuild -SignThumbprint …`, or the SignPath workflow).
3. `node tools/sign-release.js --notes "..."` (the Ed25519 update signature; the key stays in `%USERPROFILE%\.mechano-dm\`).
4. Upload `Mechano.DM.Setup.exe`, `Mechano.DM.zip` and `version.json` to the GitHub release.
