param(
    [Parameter(Mandatory = $true)][string]$ImagePath,
    [string]$Language = "zh-Hans-CN"
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Storage.Streams.InMemoryRandomAccessStream, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Storage.Streams.DataWriter, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType = WindowsRuntime]
$null = [Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime]

$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq "AsTask" -and
    $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq "IAsyncOperation``1"
})[0]

function Await($operation, $resultType) {
    $task = $asTask.MakeGenericMethod($resultType).Invoke($null, @($operation))
    $task.Wait(-1) | Out-Null
    $task.Result
}

$imageBytes = [System.IO.File]::ReadAllBytes((Resolve-Path -LiteralPath $ImagePath).Path)
$stream = New-Object -TypeName Windows.Storage.Streams.InMemoryRandomAccessStream
$writer = New-Object -TypeName Windows.Storage.Streams.DataWriter -ArgumentList $stream
$writer.WriteBytes($imageBytes)
Await ($writer.StoreAsync()) ([UInt32]) | Out-Null
$writer.DetachStream() | Out-Null
$stream.Seek(0)
$decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
$bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
$ocrLanguage = New-Object -TypeName Windows.Globalization.Language -ArgumentList $Language
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($ocrLanguage)
if ($null -eq $engine) {
    throw "OCR language not available: $Language"
}
$result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])

$lines = @()
foreach ($line in $result.Lines) {
    $words = @()
    $left = [double]::PositiveInfinity
    $top = [double]::PositiveInfinity
    $right = 0.0
    $bottom = 0.0
    foreach ($word in $line.Words) {
        $r = $word.BoundingRect
        $words += [ordered]@{
            text = $word.Text
            rect = @([int][math]::Round($r.X), [int][math]::Round($r.Y),
                     [int][math]::Round($r.Width), [int][math]::Round($r.Height))
        }
        if ($r.X -lt $left) { $left = $r.X }
        if ($r.Y -lt $top) { $top = $r.Y }
        if (($r.X + $r.Width) -gt $right) { $right = $r.X + $r.Width }
        if (($r.Y + $r.Height) -gt $bottom) { $bottom = $r.Y + $r.Height }
    }
    if ($words.Count -gt 0) {
        $lines += [ordered]@{
            text = $line.Text
            rect = @([int][math]::Round($left), [int][math]::Round($top),
                     [int][math]::Round($right - $left), [int][math]::Round($bottom - $top))
            words = $words
        }
    }
}

[ordered]@{
    schema_version = 1
    engine = "Windows.Media.Ocr"
    language = $engine.RecognizerLanguage.LanguageTag
    image_width = $decoder.PixelWidth
    image_height = $decoder.PixelHeight
    lines = $lines
} | ConvertTo-Json -Compress -Depth 8
