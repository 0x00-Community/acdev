#Requires -Version 5.1
[CmdletBinding()]
param(
    [string]$Version = $env:ACDEV_VERSION,
    [switch]$NoModifyPath = [bool]$env:ACDEV_NO_MODIFY_PATH
)

function Install-Acde {
    [CmdletBinding()]
    param(
        [string]$Version,
        [switch]$NoModifyPath
    )

    Set-StrictMode -Version 3.0
    $ErrorActionPreference = 'Stop'
    $progress = $ProgressPreference
    $ProgressPreference = 'SilentlyContinue'

    $dist = if ($env:ACDEV_DIST) { $env:ACDEV_DIST.TrimEnd('/') } else { 'https://pkgs.dopame.ai/acde' }
    $install = if ($env:ACDEV_INSTALL) { $env:ACDEV_INSTALL } else { Join-Path -Path $HOME -ChildPath '.acdev' }

    $shell = $PSVersionTable.PSVersion
    $desktop = $PSVersionTable.PSEdition -ne 'Core'
    if ($desktop) {
        if ($shell -lt [version]'5.1') {
            throw "acdev: needs Windows PowerShell 5.1 or PowerShell 7.2+, this is $shell"
        }
        $protocols = [Net.ServicePointManager]::SecurityProtocol
        [Net.ServicePointManager]::SecurityProtocol = $protocols -bor [Net.SecurityProtocolType]::Tls12
    } else {
        if (-not $IsWindows) {
            throw "acdev: install.ps1 is for Windows; on macOS and Linux run: curl -fsSL $dist/install.sh | sh"
        }
        if ($shell -lt [version]'7.2') {
            throw "acdev: PowerShell $shell is out of support: use PowerShell 7.2+ or Windows PowerShell 5.1"
        }
    }

    Add-Type -AssemblyName System.Net.Http
    $shows = $progress -ne 'SilentlyContinue' -and -not [Console]::IsOutputRedirected
    $invariant = [System.Globalization.CultureInfo]::InvariantCulture

    function Format-Size([long]$Bytes) {
        if ($Bytes -ge 1MB) {
            return ([double]$Bytes / 1MB).ToString('0.0', $invariant) + ' MB'
        }
        return [string][math]::Ceiling([double]$Bytes / 1KB) + ' KB'
    }

    function Get-Reason($Record) {
        $e = $Record.Exception
        while ($e.InnerException) {
            $e = $e.InnerException
        }
        return $e.Message
    }

    function Wait-Task($Task, [string]$Doing) {
        $clock = [System.Diagnostics.Stopwatch]::StartNew()
        while (-not $Task.Wait(250)) {
            if ($clock.Elapsed.TotalSeconds -ge 30) {
                throw (New-Object -TypeName System.TimeoutException -ArgumentList "no data for 30 s while $Doing")
            }
        }
        return $Task.Result
    }

    function Receive-Once([string]$Uri, [string]$OutFile, [string]$Label) {
        if ($Label) {
            $ProgressPreference = 'Continue'
        }
        $response = $null
        $source = $null
        $sink = $null
        try {
            $asked = $http.GetAsync($Uri, [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead)
            $response = Wait-Task $asked 'waiting for an answer'
            $code = [int]$response.StatusCode
            if (-not $response.IsSuccessStatusCode) {
                return [pscustomobject]@{ Done = $false; Retry = ($code -ge 500 -or $code -eq 408 -or $code -eq 429); Reason = "HTTP $code" }
            }
            $total = $response.Content.Headers.ContentLength
            if ($script:announce) {
                $sized = if ($total) { " ($(Format-Size $total))" } else { '' }
                Write-Host "acdev: downloading $script:announce$sized"
                $script:announce = $null
            }
            $source = Wait-Task ($response.Content.ReadAsStreamAsync()) 'opening the download'
            $sink = [System.IO.File]::Create($OutFile)
            $buffer = New-Object -TypeName byte[] -ArgumentList 262144
            $got = [long]0
            $clock = [System.Diagnostics.Stopwatch]::StartNew()
            $next = 0
            while ($true) {
                $read = Wait-Task ($source.ReadAsync($buffer, 0, $buffer.Length)) 'downloading'
                if ($read -le 0) {
                    break
                }
                $sink.Write($buffer, 0, $read)
                $got += $read
                if ($Label -and $clock.ElapsedMilliseconds -ge $next) {
                    $next = $clock.ElapsedMilliseconds + 200
                    $rate = $got / [math]::Max($clock.Elapsed.TotalSeconds, 0.001)
                    $activity = $Label
                    if ($total) {
                        $status = "$(Format-Size $got) of $(Format-Size $total), $(Format-Size ([long]$rate))/s"
                        $left = [int][math]::Ceiling(($total - $got) / [math]::Max($rate, 1))
                        $percent = [int][math]::Floor(100 * $got / $total)
                        Write-Progress -Activity $activity -Status $status -PercentComplete $percent -SecondsRemaining $left
                    } else {
                        Write-Progress -Activity $activity -Status "$(Format-Size $got), $(Format-Size ([long]$rate))/s"
                    }
                }
            }
            if ($total -and $got -ne $total) {
                return [pscustomobject]@{ Done = $false; Retry = $true; Reason = "the connection closed after $got of $total bytes" }
            }
            return [pscustomobject]@{ Done = $true; Retry = $false; Reason = $null }
        } finally {
            if ($sink) {
                $sink.Dispose()
            }
            if ($source) {
                $source.Dispose()
            }
            if ($response) {
                $response.Dispose()
            }
            if ($Label) {
                Write-Progress -Activity $Label -Completed
            }
        }
    }

    function Save-Remote([string]$Uri, [string]$OutFile, [switch]$Shown) {
        $label = if ($Shown -and $shows) { Split-Path -Path $OutFile -Leaf } else { $null }
        $script:announce = if ($Shown) { Split-Path -Path $OutFile -Leaf } else { $null }
        $reason = $null
        for ($attempt = 1; $attempt -le 3; $attempt++) {
            if ($attempt -gt 1) {
                Write-Host "acdev: ${reason}: trying again ($attempt of 3)"
                Start-Sleep -Seconds ($attempt - 1)
            }
            try {
                $result = Receive-Once $Uri $OutFile $label
                if ($result.Done) {
                    return
                }
                $reason = $result.Reason
                if (-not $result.Retry) {
                    break
                }
            } catch {
                $http.CancelPendingRequests()
                $reason = Get-Reason $_
            }
        }
        throw "acdev: could not download ${Uri}: $reason"
    }

    $cpu = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
    $triple = switch ($cpu) {
        'AMD64' { 'x86_64-pc-windows-msvc' }
        'ARM64' { 'aarch64-pc-windows-msvc' }
        default { "$("$cpu".ToLowerInvariant())-pc-windows-msvc" }
    }

    function Get-Listed([string]$Sums, [string]$File) {
        foreach ($line in Get-Content -LiteralPath $Sums) {
            $fields = $line.Trim() -split '\s+', 2
            if ($fields.Count -eq 2 -and $fields[1].TrimStart('*') -eq $File) {
                return $fields[0].ToLowerInvariant()
            }
        }
        return $null
    }

    function Assert-Sum([string]$Sums, [string]$File, [string]$Path) {
        $want = Get-Listed $Sums $File
        if (-not $want) {
            throw "acdev: $File is not in its SHA256SUMS"
        }
        $got = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($got -ne $want) {
            throw "acdev: checksum mismatch for ${File}: expected $want, got $got; not installing it"
        }
    }

    function Confirm-Download([string]$Sums, [string]$File, [string]$Path) {
        Assert-Sum $Sums $File $Path
        Write-Host "acdev: ${File}: $(Format-Size (Get-Item -LiteralPath $Path).Length), SHA-256 matches"
    }

    $tar = Join-Path -Path $env:SystemRoot -ChildPath 'System32\tar.exe'
    if (-not (Test-Path -LiteralPath $tar -PathType Leaf)) {
        throw 'acdev: needs tar.exe, which Windows 10 1803 and later ship'
    }

    $temp = [System.IO.Path]::GetTempPath()
    $work = Join-Path -Path $temp -ChildPath ("acdev-install-" + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $work | Out-Null
    $http = New-Object -TypeName System.Net.Http.HttpClient
    $http.Timeout = [System.Threading.Timeout]::InfiniteTimeSpan
    try {
        if (-not $Version) {
            Write-Host "acdev: looking up the latest acdev at $dist"
            $latest = Join-Path -Path $work -ChildPath 'latest'
            Save-Remote "$dist/latest" $latest
            $Version = (Get-Content -LiteralPath $latest -Raw).Trim()
        }
        if ($Version -notmatch '^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$') {
            throw "acdev: bad version '$Version' (x.y.z)"
        }
        $name = "acdev-$Version"
        Write-Host "acdev: installing $name from $dist"
        $tarball = Join-Path -Path $work -ChildPath "$name.tar.gz"
        $sums = Join-Path -Path $work -ChildPath 'SHA256SUMS'
        Save-Remote "$dist/$Version/SHA256SUMS" $sums
        Save-Remote "$dist/$Version/$name.tar.gz" $tarball -Shown

        Confirm-Download $sums "$name.tar.gz" $tarball
        $binary = "acdev-runtime-$triple.tar.gz"
        if (-not (Get-Listed $sums $binary)) {
            if (Get-Listed $sums 'acdert-version') {
                throw ("acdev: acdev $Version comes from before acdev and its runtime were released together: " +
                    'leave out -Version and ACDEV_VERSION for the latest')
            }
            $supported = @(Get-Content -LiteralPath $sums | ForEach-Object {
                $fields = $_.Trim() -split '\s+', 2
                if ($fields.Count -eq 2) { $fields[1].TrimStart('*') }
            } | Where-Object { $_ -like 'acdev-runtime-*' } | ForEach-Object {
                ($_ -replace '^acdev-runtime-', '') -replace '\.tar\.[gx]z$', ''
            } | Sort-Object -Unique)
            throw ("acdev: acdev $Version has no acdev runtime for this platform ($triple); " +
                "it is built for: $($supported -join ' ')")
        }
        $bundle = "acde-host-$Version.tar.gz"
        Write-Host "acdev: getting acdev runtime $Version for $triple"
        $binaryFile = Join-Path -Path $work -ChildPath $binary
        $bundleFile = Join-Path -Path $work -ChildPath $bundle
        Save-Remote "$dist/$Version/$binary" $binaryFile -Shown
        Confirm-Download $sums $binary $binaryFile
        Save-Remote "$dist/$Version/$bundle" $bundleFile -Shown
        Confirm-Download $sums $bundle $bundleFile

        Write-Host "acdev: unpacking"
        $unpacked = Join-Path -Path $work -ChildPath 'x'
        New-Item -ItemType Directory -Path $unpacked | Out-Null
        & $tar -xzf $tarball -C $unpacked
        if ($LASTEXITCODE -ne 0) {
            throw "acdev: could not unpack $name.tar.gz (tar exit $LASTEXITCODE)"
        }
        $staged = Join-Path -Path $unpacked -ChildPath $name
        $runtimeDir = Join-Path -Path $work -ChildPath 'runtime'
        New-Item -ItemType Directory -Path $runtimeDir | Out-Null
        & $tar -xzf $binaryFile -C $runtimeDir
        if ($LASTEXITCODE -ne 0) {
            throw "acdev: could not unpack $binary (tar exit $LASTEXITCODE)"
        }
        $runtimeExe = Join-Path -Path $runtimeDir -ChildPath 'acdev.exe'
        if (-not (Test-Path -LiteralPath $runtimeExe -PathType Leaf)) {
            throw "acdev: $binary does not hold acdev.exe"
        }
        New-Item -ItemType Directory -Force -Path (Join-Path -Path $staged -ChildPath 'libexec') | Out-Null
        Copy-Item -LiteralPath $runtimeExe -Destination (Join-Path -Path $staged -ChildPath 'libexec\acdev.exe')
        $bundleDir = Join-Path -Path $work -ChildPath 'host'
        New-Item -ItemType Directory -Path $bundleDir | Out-Null
        & $tar -xzf $bundleFile -C $bundleDir
        if ($LASTEXITCODE -ne 0) {
            throw "acdev: could not unpack $bundle (tar exit $LASTEXITCODE)"
        }
        $broker = Join-Path -Path $bundleDir -ChildPath 'app\dist\broker.js'
        if (-not (Test-Path -LiteralPath $broker -PathType Leaf)) {
            throw "acdev: $bundle does not hold app/dist/broker.js"
        }
        $app = Join-Path -Path $staged -ChildPath 'libexec\app'
        Move-Item -LiteralPath (Join-Path -Path $bundleDir -ChildPath 'app') -Destination $app

        $versions = Join-Path -Path $install -ChildPath 'versions'
        $target = Join-Path -Path $versions -ChildPath $Version
        New-Item -ItemType Directory -Path $versions -Force | Out-Null
        $olds = @(Get-ChildItem -LiteralPath $versions -Directory -Filter "*.old-*")
        foreach ($stale in $olds) {
            Remove-Item -LiteralPath $stale.FullName -Recurse -Force -ErrorAction SilentlyContinue
            if (Test-Path -LiteralPath $stale.FullName) {
                Write-Host "acdev: $($stale.FullName), an earlier copy, is still in use; it is removed on a later run"
            }
        }
        $aside = $null
        if (Test-Path -LiteralPath $target) {
            $aside = "$Version.old-" + [guid]::NewGuid().ToString('N')
            try {
                Rename-Item -LiteralPath $target -NewName $aside
            } catch {
                throw ("acdev: could not replace $target, a program in it is still running: " +
                    'stop acdev dev (and acdev runtime) and run the installer again')
            }
        }
        Move-Item -LiteralPath $staged -Destination $target
        if ($aside) {
            $asideDir = Join-Path -Path $versions -ChildPath $aside
            Remove-Item -LiteralPath $asideDir -Recurse -Force -ErrorAction SilentlyContinue
            if (Test-Path -LiteralPath $asideDir) {
                Write-Host ("acdev: the files acdev $Version replaced are still in use (a running acdev dev?); " +
                    "stop it and delete $asideDir, or run the installer again later and it removes it")
            }
        }

        $current = Join-Path -Path $install -ChildPath 'current'
        $next = Join-Path -Path $install -ChildPath 'current.next'
        $previous = $null
        if (Test-Path -LiteralPath $current) {
            $pointed = @((Get-Item -LiteralPath $current -Force).Target)[0]
            if ($pointed) { $previous = Split-Path -Path ([string]$pointed) -Leaf }
        }
        if (Test-Path -LiteralPath $next) {
            [System.IO.Directory]::Delete($next)
        }
        New-Item -ItemType Junction -Path $next -Target $target | Out-Null
        if (Test-Path -LiteralPath $current) {
            [System.IO.Directory]::Delete($current)
        }
        Rename-Item -LiteralPath $next -NewName 'current'

        foreach ($old in @(Get-ChildItem -LiteralPath $versions -Directory)) {
            if ($old.Name -eq $Version -or $old.Name -eq $previous -or $old.Name -like '*.old-*') { continue }
            $gone = "$($old.Name).old-" + [guid]::NewGuid().ToString('N')
            try {
                Rename-Item -LiteralPath $old.FullName -NewName $gone -ErrorAction Stop
            } catch {
                Write-Host ("acdev: kept acdev $($old.Name) ($($old.FullName)): a program in it is still running; " +
                    'the next install removes it')
                continue
            }
            Remove-Item -LiteralPath (Join-Path -Path $versions -ChildPath $gone) -Recurse -Force -ErrorAction SilentlyContinue
            Write-Host "acdev: removed acdev $($old.Name) ($($old.FullName))"
        }
    } finally {
        $http.Dispose()
        Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
    }

    $bin = Join-Path -Path $install -ChildPath 'current\bin'
    if (-not $NoModifyPath) {
        $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
        try {
            $flags = [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames
            $old = [string]$key.GetValue('Path', '', $flags)
            $entries = @($old -split ';' | Where-Object { $_ })
            $others = @($entries | Where-Object { $_ -ne $bin })
            $next = (@($bin) + $others) -join ';'
            if ($next -ne $old) {
                $key.SetValue('Path', $next, [Microsoft.Win32.RegistryValueKind]::ExpandString)
                $how = if ($entries -contains $bin) { 'moved' } else { 'added' }
                Write-Host "acdev: $how $bin to the front of your user PATH"
            }
        } finally {
            $key.Close()
        }
        [Environment]::SetEnvironmentVariable('ACDEV_INSTALL', $install, [EnvironmentVariableTarget]::User)
        $env:Path = (@($bin) + @($env:Path -split ';' | Where-Object { $_ -and $_ -ne $bin })) -join ';'
        $system = [string][Environment]::GetEnvironmentVariable('Path', [EnvironmentVariableTarget]::Machine)
        foreach ($dir in @($system -split ';' | Where-Object { $_ -and $_ -ne $bin })) {
            $expanded = [Environment]::ExpandEnvironmentVariables($dir)
            foreach ($name in 'acdev.exe', 'acdev.cmd', 'acdev.bat') {
                if (Test-Path -LiteralPath (Join-Path -Path $expanded -ChildPath $name) -PathType Leaf) {
                    Write-Host ("acdev: warning: $expanded on the system PATH has another $name, and the system " +
                        'PATH comes before yours: new terminals run that one until it is removed')
                    break
                }
            }
        }
    }

    Write-Host "acdev: installed acdev $Version with acdev runtime $Version into $install"
    Write-Host "  acdev     $(Join-Path -Path $bin -ChildPath 'acdev.cmd')"
    Write-Host "  runtime   $(Join-Path -Path (Split-Path -Parent $bin) -ChildPath 'libexec\acdev.exe')"
    Write-Host '  acdev new my-app    starts a project with your Bun or Node.js (npm, pnpm, yarn)'
    Write-Host '  acdev skills install    teaches a coding agent (Claude Code, Codex, Cursor and others) to use acdev'

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
            Write-Host ("acdev: needs Bun 1.4 or newer, and the bun on PATH is ${bunVersion}: " +
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
            Write-Host ("acdev: needs Node.js 22.3 or newer, and the node on PATH is ${nodeVersion}: " +
                'update it (https://nodejs.org)')
        }
    }
    if (-not $runs -and -not $bun -and -not $node) {
        Write-Host ('acdev: runs on Bun 1.4 or newer, or Node.js 22.3 or newer, and found neither: ' +
            'install Bun (https://bun.sh) or Node.js (https://nodejs.org)')
    }
    if (@($env:Path -split ';') -notcontains $bin) {
        if ($NoModifyPath) {
            Write-Host "acdev: $bin is not on PATH; add it to your user Path, and in this terminal run:"
        } else {
            Write-Host 'acdev: acdev is on PATH in new terminals; in this one, run:'
        }
        Write-Host ''
        Write-Host "  `$env:Path = `"$bin;`$env:Path`""
        Write-Host ''
    }
}

try {
    Install-Acde -Version $Version -NoModifyPath:$NoModifyPath
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    $global:LASTEXITCODE = 1
    if ($PSCommandPath -and (Split-Path -Leaf $PSCommandPath) -eq 'install.ps1') { exit 1 }
}
