& {
    param([object[]] $ForwardedArgs)

    Set-StrictMode -Version Latest
    $ErrorActionPreference = 'Stop'
    $programName = 'agygram'

    function Fail-Uninstall([string] $Message) {
        throw "$programName uninstall: $Message"
    }

    if ($null -eq $ForwardedArgs) {
        $ForwardedArgs = @()
    }

    if ($ForwardedArgs.Count -eq 1 -and (
        [string] $ForwardedArgs[0] -eq '--help' -or [string] $ForwardedArgs[0] -eq '-h'
    )) {
        Write-Output @'
Uninstall the managed agygram application.

Usage:
  uninstall.ps1 [--install-root <absolute-path>]

The bot configuration, runtime data, workspace, and credentials are preserved.
'@
        return
    }

    $rootArgument = $null
    $rootArgumentSeen = $false

    for ($index = 0; $index -lt $ForwardedArgs.Count; $index++) {
        $argument = [string] $ForwardedArgs[$index]
        if ($argument -eq '--') {
            Fail-Uninstall '-- option delimiters are not supported'
        }

        if ($argument -eq '--install-root') {
            if ($rootArgumentSeen) {
                Fail-Uninstall '--install-root may only be specified once'
            }
            if (($index + 1) -ge $ForwardedArgs.Count) {
                Fail-Uninstall '--install-root requires a path'
            }
            $index++
            $rootArgument = [string] $ForwardedArgs[$index]
            if ([string]::IsNullOrEmpty($rootArgument)) {
                Fail-Uninstall '--install-root requires a non-empty path'
            }
            $rootArgumentSeen = $true
            continue
        }

        if ($argument.StartsWith('--install-root=', [StringComparison]::Ordinal)) {
            Fail-Uninstall 'use --install-root <path>, without an equals sign'
        }
    }

    $isWindowsPlatform = [Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT
    $isMacPlatform = [Environment]::OSVersion.Platform -eq [PlatformID]::MacOSX
    if (-not $isWindowsPlatform -and -not $isMacPlatform) {
        try {
            $isMacPlatform = (& uname -s 2>$null) -eq 'Darwin'
        } catch {
            $isMacPlatform = $false
        }
    }

    function Test-StrictAbsolutePath([string] $Value) {
        if ([string]::IsNullOrEmpty($Value)) {
            return $false
        }
        if ($Value -match '[\x00-\x1f\x7f]') {
            return $false
        }
        if ($isWindowsPlatform) {
            return $Value -match '\A(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+(?:[\\/]|$))'
        }
        return [IO.Path]::IsPathRooted($Value)
    }

    if ($rootArgumentSeen) {
        $installRoot = $rootArgument
    } elseif ($null -ne [Environment]::GetEnvironmentVariable('AGYGRAM_INSTALL_ROOT')) {
        $installRoot = [Environment]::GetEnvironmentVariable('AGYGRAM_INSTALL_ROOT')
        if ([string]::IsNullOrEmpty($installRoot)) {
            Fail-Uninstall 'AGYGRAM_INSTALL_ROOT must not be empty'
        }
    } elseif ($isWindowsPlatform) {
        if ([string]::IsNullOrEmpty($env:LOCALAPPDATA)) {
            Fail-Uninstall 'LOCALAPPDATA is required to locate the installation'
        }
        $installRoot = Join-Path $env:LOCALAPPDATA 'agygram\manager'
    } elseif ($isMacPlatform) {
        if ([string]::IsNullOrEmpty($env:HOME)) {
            Fail-Uninstall 'HOME is required to locate the installation'
        }
        $installRoot = Join-Path $env:HOME 'Library/Application Support/agygram/manager'
    } else {
        if ([string]::IsNullOrEmpty($env:HOME)) {
            Fail-Uninstall 'HOME is required to locate the installation'
        }
        if (-not [string]::IsNullOrEmpty($env:XDG_DATA_HOME)) {
            $installRoot = Join-Path $env:XDG_DATA_HOME 'agygram/manager'
        } else {
            $installRoot = Join-Path $env:HOME '.local/share/agygram/manager'
        }
    }

    if (-not (Test-StrictAbsolutePath $installRoot)) {
        Fail-Uninstall 'the install root must be an absolute path'
    }

    $currentFile = Join-Path $installRoot 'current'
    if (-not (Test-Path -LiteralPath $installRoot)) {
        Write-Output "$programName is not installed; nothing to remove."
        return
    }
    $pointerMode = 'missing'
    $releaseBasename = ''
    if (Test-Path -LiteralPath $currentFile) {
        $pointerMode = 'current'
        $currentItem = Get-Item -LiteralPath $currentFile -Force
        if ($currentItem.PSIsContainer -or (($currentItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) {
            Fail-Uninstall "invalid current release pointer: $currentFile"
        }
        if ($currentItem.Length -le 0 -or $currentItem.Length -gt 256) {
            Fail-Uninstall 'the current release pointer is malformed'
        }

        $strictUtf8 = New-Object Text.UTF8Encoding($false, $true)
        try {
            $currentText = $strictUtf8.GetString([IO.File]::ReadAllBytes($currentFile))
        } catch {
            Fail-Uninstall 'the current release pointer is not valid UTF-8'
        }

        $semver = '(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-(?:(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+(?:[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?'
        $pointerPattern = "\Av($semver)-([0-9a-f]{40})\r?\n\z"
        $pointerMatch = [Text.RegularExpressions.Regex]::Match($currentText, $pointerPattern, [Text.RegularExpressions.RegexOptions]::CultureInvariant)
        if (-not $pointerMatch.Success) {
            Fail-Uninstall 'the current release pointer is malformed'
        }
        $releaseBasename = $currentText.TrimEnd("`r", "`n")
    }

    $nodeCommand = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue
    if ($null -eq $nodeCommand) {
        $nodeCommand = Get-Command node -CommandType Application -ErrorAction SilentlyContinue
    }
    if ($null -eq $nodeCommand) {
        Fail-Uninstall 'Node.js 22 or 24 is required to uninstall agygram'
    }
    $nodePath = $nodeCommand.Source

    $oldNodeOptions = [Environment]::GetEnvironmentVariable('NODE_OPTIONS')
    $oldNodePath = [Environment]::GetEnvironmentVariable('NODE_PATH')
    $oldTlsSetting = [Environment]::GetEnvironmentVariable('NODE_TLS_REJECT_UNAUTHORIZED')
    $verificationDirectory = $null
    try {
        $env:NODE_OPTIONS = ''
        $env:NODE_PATH = ''
        $env:NODE_TLS_REJECT_UNAUTHORIZED = '1'
        $nodeMajor = (& $nodePath -p "process.versions.node.split('.')[0]")
        if ($LASTEXITCODE -ne 0 -or ($nodeMajor -ne '22' -and $nodeMajor -ne '24')) {
            Fail-Uninstall 'Node.js 22 or 24 is required to uninstall agygram'
        }

        $verificationDirectory = Join-Path ([IO.Path]::GetTempPath()) ("agygram-uninstall-" + [Guid]::NewGuid().ToString('N'))
        [void] [IO.Directory]::CreateDirectory($verificationDirectory)
        if ($isWindowsPlatform) {
            $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
            $directorySecurity = New-Object Security.AccessControl.DirectorySecurity
            $directorySecurity.SetAccessRuleProtection($true, $false)
            $inheritance = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
            $accessRule = New-Object Security.AccessControl.FileSystemAccessRule(
                $identity.User,
                [Security.AccessControl.FileSystemRights]::FullControl,
                $inheritance,
                [Security.AccessControl.PropagationFlags]::None,
                [Security.AccessControl.AccessControlType]::Allow
            )
            [void] $directorySecurity.AddAccessRule($accessRule)
            Set-Acl -LiteralPath $verificationDirectory -AclObject $directorySecurity
        }

        $verifier = Join-Path $verificationDirectory 'verify.mjs'
        $verifierSource = @'
import { createHash } from 'node:crypto';
import { chmod, lstat, open, realpath } from 'node:fs/promises';
import https from 'node:https';
import path from 'node:path';
import process from 'node:process';
import { TextDecoder } from 'node:util';

const OWNER = 'agygram-managed-installer';
const REPOSITORY = 'parkjangwon/antigravity-telegram-cli';
const PACKAGE = 'antigravity-telegram-cli';
const SEMVER = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-(?:(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+(?:[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const COMMIT = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const utf8 = new TextDecoder('utf-8', { fatal: true });
const [rootArgument, pointerMode, expectedRelease, verifiedCopy] = process.argv.slice(2);
const API_ORIGIN = 'https://api.github.com';
const MAX_API_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 60_000;

function fail(message) {
  throw new Error(message);
}

function getJson(apiPath) {
  const url = new URL(apiPath, API_ORIGIN);
  if (url.protocol !== 'https:' || url.origin !== API_ORIGIN) fail('invalid GitHub API URL');
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(overallTimer);
      if (error) reject(error);
      else resolve(value);
    };
    const request = https.get(url, {
      headers: {
        Accept: 'application/vnd.github+json',
        'Accept-Encoding': 'identity',
        'User-Agent': 'agygram-uninstaller-bootstrap/0.1.0',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    }, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        finish(new Error(`GitHub request failed with HTTP ${response.statusCode ?? 0}`));
        return;
      }
      const chunks = [];
      let length = 0;
      response.on('data', (chunk) => {
        length += chunk.length;
        if (length > MAX_API_BYTES) response.destroy(new Error('GitHub response exceeded its size limit'));
        else chunks.push(chunk);
      });
      response.once('error', (error) => finish(error));
      response.once('end', () => {
        const declared = response.headers['content-length'];
        if (declared && Number(declared) !== length) {
          finish(new Error('GitHub response was truncated'));
          return;
        }
        try {
          finish(null, JSON.parse(Buffer.concat(chunks, length).toString('utf8')));
        } catch {
          finish(new Error('GitHub returned invalid JSON'));
        }
      });
    });
    request.setTimeout(20_000, () => request.destroy(new Error('GitHub request stalled')));
    request.once('error', (error) => finish(error));
    const overallTimer = setTimeout(() => request.destroy(new Error('GitHub request timed out')), REQUEST_TIMEOUT_MS);
  });
}

async function resolveTagCommit(tag) {
  const reference = await getJson(`/repos/parkjangwon/antigravity-telegram-cli/git/ref/tags/${encodeURIComponent(tag)}`);
  if (reference?.ref !== `refs/tags/${tag}` || !reference.object) fail('release tag reference is invalid');
  let object = reference.object;
  for (let depth = 0; depth < 5; depth++) {
    if (!COMMIT.test(object?.sha ?? '')) fail('release tag has an invalid object ID');
    if (object.type === 'commit') return object.sha;
    if (object.type !== 'tag') fail('release tag does not resolve to a commit');
    const annotated = await getJson(`/repos/parkjangwon/antigravity-telegram-cli/git/tags/${object.sha}`);
    if (depth === 0 && annotated?.tag !== tag) fail('annotated release tag name did not match');
    object = annotated?.object;
  }
  fail('release tag indirection is too deep');
}

function samePath(left, right) {
  const normalize = (value) => {
    const result = path.normalize(value);
    return process.platform === 'win32' ? result.toLowerCase() : result;
  };
  return normalize(left) === normalize(right);
}

function assertIdentity(value, label) {
  if (!value || value.schemaVersion !== 1 || value.owner !== OWNER || value.repository !== REPOSITORY) {
    fail(`${label} identity is invalid`);
  }
}

function assertOwned(info, target) {
  if (process.platform !== 'win32' && process.getuid && info.uid !== process.getuid()) {
    fail(`managed path has an unexpected owner: ${target}`);
  }
}

async function assertDirectory(target, privateDirectory = false) {
  const info = await lstat(target);
  if (!info.isDirectory() || info.isSymbolicLink()) fail(`managed directory is invalid: ${target}`);
  assertOwned(info, target);
  if (process.platform !== 'win32') {
    const forbidden = privateDirectory ? 0o077 : 0o022;
    if ((info.mode & forbidden) !== 0) fail(`managed directory permissions are unsafe: ${target}`);
  }
  const canonical = await realpath(target);
  if (!samePath(canonical, path.resolve(target))) fail(`managed directory is not canonical: ${target}`);
}

async function readRegular(target, maximumBytes, privateFile = false) {
  const info = await lstat(target);
  if (!info.isFile() || info.isSymbolicLink() || info.size <= 0 || info.size > maximumBytes) {
    fail(`managed file is invalid: ${target}`);
  }
  assertOwned(info, target);
  if (process.platform !== 'win32') {
    const forbidden = privateFile ? 0o077 : 0o022;
    if ((info.mode & forbidden) !== 0) fail(`managed file permissions are unsafe: ${target}`);
  }
  const handle = await open(target, 'r');
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size !== info.size || opened.dev !== info.dev || opened.ino !== info.ino) {
      fail(`managed file changed while opening: ${target}`);
    }
    const bytes = await handle.readFile();
    if (bytes.length !== opened.size) fail(`managed file changed while reading: ${target}`);
    return bytes;
  } finally {
    await handle.close();
  }
}

async function readJson(target, maximumBytes, privateFile = false) {
  const bytes = await readRegular(target, maximumBytes, privateFile);
  try {
    const value = JSON.parse(utf8.decode(bytes));
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('JSON receipt must be an object');
    return value;
  } catch (error) {
    fail(`managed JSON receipt is invalid: ${path.basename(target)} (${error.message})`);
  }
}

async function main() {
  if (!rootArgument || !path.isAbsolute(rootArgument) || !['current', 'missing'].includes(pointerMode) ||
      !verifiedCopy || !path.isAbsolute(verifiedCopy) || (pointerMode === 'missing' && expectedRelease !== '-')) {
    fail('invalid verifier arguments');
  }
  const root = path.resolve(rootArgument);
  await assertDirectory(root, true);

  const rootMarker = await readJson(path.join(root, '.agygram-managed-root.json'), 1024 * 1024, true);
  assertIdentity(rootMarker, 'install root marker');
  if (typeof rootMarker.installRoot !== 'string' || !samePath(rootMarker.installRoot, root)) {
    fail('install root marker does not match the selected root');
  }

  const manifest = await readJson(path.join(root, 'manifest.json'), 1024 * 1024, true);
  assertIdentity(manifest, 'manifest');
  if (!SEMVER.test(manifest.version ?? '') || !COMMIT.test(manifest.commit ?? '')) {
    fail('manifest release identity is invalid');
  }
  const releaseName = `v${manifest.version}-${manifest.commit}`;
  if (manifest.tag !== `v${manifest.version}` || manifest.currentRelease !== releaseName ||
      (pointerMode === 'current' && expectedRelease !== releaseName)) {
    fail('manifest, current pointer, and requested release do not match');
  }

  if (typeof manifest.serviceInstalled !== 'boolean') fail('manifest service state is invalid');

  const currentPath = path.join(root, 'current');
  if (pointerMode === 'current') {
    const currentBytes = await readRegular(currentPath, 256, true);
    if (!currentBytes.equals(Buffer.from(`${releaseName}\n`, 'utf8'))) fail('current pointer contents are invalid');
  } else {
    try {
      await lstat(currentPath);
      fail('current pointer appeared during recovery; retry the uninstall');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  const releases = path.join(root, 'releases');
  const releaseDirectory = path.join(releases, releaseName);
  await assertDirectory(releases, true);
  await assertDirectory(releaseDirectory, true);

  const releaseMarker = await readJson(path.join(releaseDirectory, '.agygram-release.json'), 1024 * 1024, true);
  assertIdentity(releaseMarker, 'release marker');
  if (releaseMarker.version !== manifest.version || releaseMarker.tag !== manifest.tag ||
      releaseMarker.commit !== manifest.commit || releaseMarker.releaseName !== releaseName ||
      !SHA256.test(releaseMarker.archiveSha256 ?? '')) {
    fail('release marker does not match the manifest');
  }

  const packageJson = await readJson(path.join(releaseDirectory, 'package.json'), 256 * 1024);
  if (packageJson.name !== PACKAGE || packageJson.version !== manifest.version) {
    fail('installed package identity does not match the manifest');
  }

  const uninstallerBytes = await readRegular(
    path.join(releaseDirectory, 'scripts', 'uninstall.mjs'),
    4 * 1024 * 1024,
  );
  const inventory = await readJson(
    path.join(releaseDirectory, '.agygram-release-inventory.json'),
    16 * 1024 * 1024,
    true,
  );
  assertIdentity(inventory, 'release inventory');
  if (!Array.isArray(inventory.records) || inventory.records.length > 50_000) {
    fail('release inventory records are invalid');
  }
  const uninstallerRecords = inventory.records.filter(
    (record) => record?.path === 'scripts/uninstall.mjs',
  );
  const inventoryDigest = createHash('sha256').update(uninstallerBytes).digest('hex');
  if (uninstallerRecords.length !== 1 || uninstallerRecords[0].type !== 'file' ||
      uninstallerRecords[0].size !== uninstallerBytes.length ||
      uninstallerRecords[0].sha256 !== inventoryDigest) {
    fail('installed uninstaller does not match the installer inventory');
  }
  const release = await getJson(
    `/repos/parkjangwon/antigravity-telegram-cli/releases/tags/${encodeURIComponent(manifest.tag)}`,
  );
  if (release?.tag_name !== manifest.tag || release.draft !== false ||
      release.prerelease !== false || release.immutable !== true) {
    fail('installed version is not an immutable stable GitHub release');
  }
  const assets = Array.isArray(release.assets)
    ? release.assets.filter((asset) => asset?.name === 'uninstall.mjs')
    : [];
  if (assets.length !== 1 || assets[0].state !== 'uploaded' || assets[0].size !== uninstallerBytes.length) {
    fail('immutable release uninstall asset metadata is invalid');
  }
  const expectedDigest = /^sha256:([0-9a-f]{64})$/i.exec(assets[0].digest ?? '')?.[1]?.toLowerCase();
  if (!expectedDigest || inventoryDigest !== expectedDigest) fail('installed uninstaller digest verification failed');
  if ((await resolveTagCommit(manifest.tag)).toLowerCase() !== manifest.commit) {
    fail('immutable release tag does not match the installed commit');
  }

  const copyHandle = await open(verifiedCopy, 'wx', 0o700);
  try {
    await copyHandle.writeFile(uninstallerBytes);
    await copyHandle.sync();
  } finally {
    await copyHandle.close();
  }
  if (process.platform !== 'win32') await chmod(verifiedCopy, 0o700);
  process.stdout.write(releaseName);
}

main().catch((error) => {
  process.stderr.write(`agygram uninstall: local installation verification failed: ${error.message}\n`);
  process.exitCode = 1;
});
'@
        $utf8WithoutBom = New-Object Text.UTF8Encoding($false)
        [IO.File]::WriteAllText($verifier, $verifierSource, $utf8WithoutBom)
        & $nodePath --check -- $verifier
        if ($LASTEXITCODE -ne 0) {
            Fail-Uninstall 'embedded local installation verifier failed its syntax self-check'
        }
        $verifiedUninstaller = Join-Path $verificationDirectory 'uninstall.mjs'
        $verifierExpected = if ($pointerMode -eq 'missing') { '-' } else { $releaseBasename }
        $verifiedRelease = (& $nodePath -- $verifier $installRoot $pointerMode $verifierExpected $verifiedUninstaller)
        if ($LASTEXITCODE -ne 0) {
            Fail-Uninstall 'local installation verification failed'
        }
        if ($verifiedRelease -is [Array] -or [string]::IsNullOrEmpty([string] $verifiedRelease)) {
            Fail-Uninstall 'local installation verifier returned an invalid release name'
        }
        $releaseBasename = [string] $verifiedRelease
        $semver = '(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-(?:(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+(?:[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?'
        if ($releaseBasename -notmatch "\Av$semver-[0-9a-f]{40}\z") {
            Fail-Uninstall 'the verified release name is malformed'
        }
        $releaseDirectory = Join-Path (Join-Path $installRoot 'releases') $releaseBasename
        $localUninstaller = Join-Path (Join-Path $releaseDirectory 'scripts') 'uninstall.mjs'
        $uninstaller = $verifiedUninstaller
        if (-not (Test-Path -LiteralPath $releaseDirectory -PathType Container)) {
            Fail-Uninstall "installed release is missing: $releaseBasename"
        }
        $releaseItem = Get-Item -LiteralPath $releaseDirectory -Force
        if (($releaseItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            Fail-Uninstall 'refusing a symbolic installed release directory'
        }
        if (-not (Test-Path -LiteralPath $localUninstaller -PathType Leaf)) {
            Fail-Uninstall "installed uninstaller is missing: $localUninstaller"
        }
        $uninstallerItem = Get-Item -LiteralPath $localUninstaller -Force
        if (($uninstallerItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            Fail-Uninstall 'refusing a symbolic installed uninstaller'
        }
        if (-not (Test-Path -LiteralPath $uninstaller -PathType Leaf)) {
            Fail-Uninstall 'verified private uninstaller copy is missing'
        }

        $invokeArguments = New-Object 'System.Collections.Generic.List[string]'
        $invokeArguments.Add('--')
        $invokeArguments.Add($uninstaller)
        if (-not $rootArgumentSeen) {
            $invokeArguments.Add('--install-root')
            $invokeArguments.Add($installRoot)
        }
        foreach ($argument in $ForwardedArgs) {
            $invokeArguments.Add([string] $argument)
        }

        $nativeArguments = $invokeArguments.ToArray()
        & $nodePath @nativeArguments
        if ($LASTEXITCODE -ne 0) {
            Fail-Uninstall "installed uninstaller exited with code $LASTEXITCODE"
        }
    } finally {
        [Environment]::SetEnvironmentVariable('NODE_OPTIONS', $oldNodeOptions)
        [Environment]::SetEnvironmentVariable('NODE_PATH', $oldNodePath)
        [Environment]::SetEnvironmentVariable('NODE_TLS_REJECT_UNAUTHORIZED', $oldTlsSetting)
        if ($null -ne $verificationDirectory -and (Test-Path -LiteralPath $verificationDirectory)) {
            try {
                Remove-Item -LiteralPath $verificationDirectory -Recurse -Force
            } catch {
                Write-Warning "$programName uninstall: could not remove verification files"
            }
        }
    }
} -ForwardedArgs $args
