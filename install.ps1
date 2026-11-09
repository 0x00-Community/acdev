#Requires -Version 5.1
[CmdletBinding()]
param(
    [string]$Version = $env:ACDE_VERSION,
    [switch]$NoModifyPath = [bool]$env:ACDE_NO_MODIFY_PATH
)

function Install-Acde {
    [CmdletBinding()]
    param(
        [string]$Version,
        [switch]$NoModifyPath
    )

    Set-StrictMode -Version 3.0
    $ErrorActionPreference = 'Stop'
    $ProgressPreference = 'SilentlyContinue'

    $dist = if ($env:ACDE_DIST) { $env:ACDE_DIST.TrimEnd('/') } else { 'https://pkgs.dopame.ai/acde' }
    $install = if ($env:ACDE_INSTALL) { $env:ACDE_INSTALL } else { Join-Path -Path $HOME -ChildPath '.acde' }

    $shell = $PSVersionTable.PSVersion
    $desktop = $PSVersionTable.PSEdition -ne 'Core'
    if ($desktop) {
        if ($shell -lt [version]'5.1') {
            throw "acde: needs Windows PowerShell 5.1 or PowerShell 7.2+, this is $shell"
        }
        $protocols = [Net.ServicePointManager]::SecurityProtocol
        [Net.ServicePointManager]::SecurityProtocol = $protocols -bor [Net.SecurityProtocolType]::Tls12
    } else {
        if (-not $IsWindows) {
            throw "acde: install.ps1 is for Windows; on macOS and Linux run: curl -fsSL $dist/install.sh | sh"
        }
        if ($shell -lt [version]'7.2') {
            throw "acde: PowerShell $shell is out of support: use PowerShell 7.2+ or Windows PowerShell 5.1"
        }
    }

    function Save-Remote([string]$Uri, [string]$OutFile) {
        try {
            if ($desktop) {
                Invoke-WebRequest -Uri $Uri -OutFile $OutFile -UseBasicParsing
            } else {
                Invoke-WebRequest -Uri $Uri -OutFile $OutFile
            }
        } catch {
            throw "acde: could not download ${Uri}: $($_.Exception.Message)"
        }
    }

    $tar = Join-Path -Path $env:SystemRoot -ChildPath 'System32\tar.exe'
    if (-not (Test-Path -LiteralPath $tar -PathType Leaf)) {
        throw 'acde: needs tar.exe, which Windows 10 1803 and later ship'
    }

    $temp = [System.IO.Path]::GetTempPath()
    $work = Join-Path -Path $temp -ChildPath ("acde-install-" + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $work | Out-Null
    try {
        if (-not $Version) {
            $latest = Join-Path -Path $work -ChildPath 'latest'
            Save-Remote "$dist/latest" $latest
            $Version = (Get-Content -LiteralPath $latest -Raw).Trim()
        }
        if ($Version -notmatch '^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$') {
            throw "acde: bad version '$Version' (x.y.z)"
        }
        $name = "acde-$Version"
        Write-Host "acde: installing $name from $dist"
        $tarball = Join-Path -Path $work -ChildPath "$name.tar.gz"
        $sums = Join-Path -Path $work -ChildPath 'SHA256SUMS'
        Save-Remote "$dist/$Version/$name.tar.gz" $tarball
        Save-Remote "$dist/$Version/SHA256SUMS" $sums

        $want = $null
        foreach ($line in Get-Content -LiteralPath $sums) {
            $fields = $line.Trim() -split '\s+', 2
            if ($fields.Count -eq 2 -and $fields[1].TrimStart('*') -eq "$name.tar.gz") {
                $want = $fields[0].ToLowerInvariant()
            }
        }
        if (-not $want) {
            throw "acde: $name.tar.gz is not in SHA256SUMS"
        }
        $got = (Get-FileHash -LiteralPath $tarball -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($got -ne $want) {
            throw "acde: checksum mismatch for ${name}.tar.gz: expected $want, got $got"
        }

        $unpacked = Join-Path -Path $work -ChildPath 'x'
        New-Item -ItemType Directory -Path $unpacked | Out-Null
        & $tar -xzf $tarball -C $unpacked
        if ($LASTEXITCODE -ne 0) {
            throw "acde: could not unpack $name.tar.gz (tar exit $LASTEXITCODE)"
        }

        $versions = Join-Path -Path $install -ChildPath 'versions'
        $target = Join-Path -Path $versions -ChildPath $Version
        New-Item -ItemType Directory -Path $versions -Force | Out-Null
        $olds = @(Get-ChildItem -LiteralPath $versions -Directory -Filter "*.old-*")
        foreach ($stale in $olds) {
            Remove-Item -LiteralPath $stale.FullName -Recurse -Force -ErrorAction SilentlyContinue
        }
        $aside = $null
        if (Test-Path -LiteralPath $target) {
            $aside = "$Version.old-" + [guid]::NewGuid().ToString('N')
            try {
                Rename-Item -LiteralPath $target -NewName $aside
            } catch {
                throw ("acde: could not replace $target, a program in it is still running: " +
                    'stop acde dev (and acdert) and run the installer again')
            }
        }
        Move-Item -LiteralPath (Join-Path -Path $unpacked -ChildPath $name) -Destination $target
        if ($aside) {
            $asideDir = Join-Path -Path $versions -ChildPath $aside
            Remove-Item -LiteralPath $asideDir -Recurse -Force -ErrorAction SilentlyContinue
        }

        $current = Join-Path -Path $install -ChildPath 'current'
        $next = Join-Path -Path $install -ChildPath 'current.next'
        if (Test-Path -LiteralPath $next) {
            [System.IO.Directory]::Delete($next)
        }
        New-Item -ItemType Junction -Path $next -Target $target | Out-Null
        if (Test-Path -LiteralPath $current) {
            [System.IO.Directory]::Delete($current)
        }
        Rename-Item -LiteralPath $next -NewName 'current'
    } finally {
        Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
    }

    $bin = Join-Path -Path $install -ChildPath 'current\bin'
    if (-not $NoModifyPath) {
        $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
        try {
            $flags = [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames
            $old = [string]$key.GetValue('Path', '', $flags)
            $entries = @($old -split ';' | Where-Object { $_ })
            if ($entries -notcontains $bin) {
                $key.SetValue('Path', (@($entries) + $bin) -join ';', [Microsoft.Win32.RegistryValueKind]::ExpandString)
                Write-Host "acde: added $bin to your user PATH"
            }
        } finally {
            $key.Close()
        }
        [Environment]::SetEnvironmentVariable('ACDE_INSTALL', $install, [EnvironmentVariableTarget]::User)
        if (@($env:Path -split ';') -notcontains $bin) {
            $env:Path = "$bin;$env:Path"
        }
    }

    Write-Host "acde: installed acde $Version into $install"
    Write-Host '  acde new my-app    starts a project with your Bun or Node.js (npm, pnpm, yarn)'
    Write-Host '  acde dev needs the Dopame runtime (acdert): run it in the Dopame virtual machine, or set ACDERT'

    $bun = Get-Command bun -ErrorAction SilentlyContinue
    $node = Get-Command node -ErrorAction SilentlyContinue
    $runs = $false
    if ($bun) {
        $bunVersion = (& $bun.Source --version 2>$null | Out-String).Trim()
        $bunOk = $false
        if ($bunVersion -match '^(\d+)\.(\d+)') {
            $bunOk = [int]$Matches[1] -gt 1 -or ([int]$Matches[1] -eq 1 -and [int]$Matches[2] -ge 4)
        }
        if ($bunOk) {
            $runs = $true
        } else {
            Write-Host ("acde: needs Bun 1.4 or newer, and the bun on PATH is ${bunVersion}: " +
                'update it (bun upgrade, or https://bun.sh)')
        }
    }
    if (-not $runs -and $node) {
        $nodeVersion = (& $node.Source -p 'process.versions.node' 2>$null | Out-String).Trim()
        $nodeOk = $false
        if ($nodeVersion -match '^(\d+)\.(\d+)') {
            $nodeOk = [int]$Matches[1] -gt 22 -or ([int]$Matches[1] -eq 22 -and [int]$Matches[2] -ge 3)
        }
        if ($nodeOk) {
            $runs = $true
        } else {
            Write-Host ("acde: needs Node.js 22.3 or newer, and the node on PATH is ${nodeVersion}: " +
                'update it (https://nodejs.org)')
        }
    }
    if (-not $runs -and -not $bun -and -not $node) {
        Write-Host ('acde: runs on Bun 1.4 or newer, or Node.js 22.3 or newer, and found neither: ' +
            'install Bun (https://bun.sh) or Node.js (https://nodejs.org)')
    }
}

Install-Acde -Version $Version -NoModifyPath:$NoModifyPath
