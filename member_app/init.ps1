# member_app ilk kurulum betiği. Flutter kurulduktan sonra BİR KEZ çalıştırın:
#     powershell -ExecutionPolicy Bypass -File .\init.ps1
#
# Yaptıkları:
#   1. Android/iOS proje iskeletini üretir (flutter create) ama lib/ ve test/ kodumuza dokunmaz
#   2. Bağımlılıkları ekler (http, mobile_scanner, flutter_secure_storage)
#   3. Android'e düz HTTP izni ve iOS'a kamera açıklaması ekler
#   4. flutter analyze ve flutter test çalıştırır
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

if (-not (Get-Command flutter -ErrorAction SilentlyContinue)) {
    throw "flutter bulunamadı. Önce Flutter'ı kurun ve PATH'e ekleyin, sonra yeni bir terminal açın."
}

# flutter create varsayılan lib/ ve test/ dosyalarını yazar; kendi kodumuzu yedekleyip geri koyuyoruz
$backup = Join-Path $env:TEMP ("member_app_src_" + [guid]::NewGuid())
New-Item -ItemType Directory $backup | Out-Null
Copy-Item lib, test -Destination $backup -Recurse

flutter create --org com.gymenter --project-name member_app --platforms android,ios .
if ($LASTEXITCODE -ne 0) { throw 'flutter create başarısız' }

Remove-Item lib, test -Recurse -Force
Copy-Item (Join-Path $backup 'lib'), (Join-Path $backup 'test') -Destination . -Recurse
Remove-Item $backup -Recurse -Force

flutter pub add http mobile_scanner flutter_secure_storage
if ($LASTEXITCODE -ne 0) { throw 'flutter pub add başarısız' }

$utf8NoBom = New-Object System.Text.UTF8Encoding $false

# Geliştirmede sunucu düz HTTP ile konuşur; Android 9+ bunu varsayılan olarak engeller.
# Canlıya çıkarken sunucuyu HTTPS'e alıp bu satırı kaldırın.
$manifest = Join-Path $PSScriptRoot 'android\app\src\main\AndroidManifest.xml'
$xml = [IO.File]::ReadAllText($manifest)
if ($xml -notmatch 'usesCleartextTraffic') {
    $xml = $xml -replace '<application', '<application android:usesCleartextTraffic="true"'
    [IO.File]::WriteAllText($manifest, $xml, $utf8NoBom)
    Write-Host 'AndroidManifest: usesCleartextTraffic eklendi'
}

$plist = Join-Path $PSScriptRoot 'ios\Runner\Info.plist'
$text = [IO.File]::ReadAllText($plist)
if ($text -notmatch 'NSCameraUsageDescription') {
    $entry = '<key>NSCameraUsageDescription</key><string>Salon girişindeki QR kodu okutmak için kamera gerekir.</string>'
    $text = $text -replace '</dict>\s*</plist>', "$entry`n</dict>`n</plist>"
    [IO.File]::WriteAllText($plist, $text, $utf8NoBom)
    Write-Host 'Info.plist: NSCameraUsageDescription eklendi'
}

flutter analyze
flutter test
