import 'package:flutter/material.dart';
import 'package:mobile_scanner/mobile_scanner.dart';

import 'api.dart';

/// Kapıdaki QR'ı okutur ve sunucuya gönderir. Başarılı girişte "ok",
/// oturum düşmüşse [unauthorized] ile kapanır.
class ScanScreen extends StatefulWidget {
  const ScanScreen({super.key, required this.api});

  static const ok = 'ok';
  static const unauthorized = 'unauthorized';

  final ApiClient api;

  @override
  State<ScanScreen> createState() => _ScanScreenState();
}

class _ScanScreenState extends State<ScanScreen> {
  // Kamera sürekli açık kalır; sonuç ekranı üstüne bindirilir. Aynı kodun art arda
  // işlenmemesi için son okunan değer hatırlanır.
  final _controller = MobileScannerController(formats: const [BarcodeFormat.qrCode]);
  bool _busy = false;
  String? _lastCode;
  ScanResult? _result;
  String? _hint;

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  void _onDetect(BarcodeCapture capture) {
    if (_busy) return;
    for (final barcode in capture.barcodes) {
      final value = barcode.rawValue;
      if (value == null || value == _lastCode) continue;
      _lastCode = value;
      if (!value.startsWith('GYM1.')) {
        setState(() => _hint = 'Bu bir salon giriş QR kodu değil.');
        return;
      }
      _submit(value);
      return;
    }
  }

  Future<void> _submit(String code) async {
    setState(() {
      _busy = true;
      _hint = null;
      _result = null;
    });
    try {
      final result = await widget.api.scan(code);
      if (!mounted) return;
      setState(() => _result = result);
      if (result.ok) {
        await Future<void>.delayed(const Duration(milliseconds: 2500));
        if (mounted) Navigator.of(context).pop(ScanScreen.ok);
      }
    } on ApiException catch (e) {
      if (!mounted) return;
      if (e.unauthorized) {
        Navigator.of(context).pop(ScanScreen.unauthorized);
        return;
      }
      setState(() => _result = ScanResult(ok: false, message: e.message));
    }
  }

  void _retry() {
    setState(() {
      _busy = false;
      _result = null;
      _hint = null;
    });
  }

  /// Kamera kullanılamadığında (izin verilmedi, emülatör) kodu elle yazma yolu.
  Future<void> _enterManually() async {
    final code = await showDialog<String>(context: context, builder: (_) => const _ManualCodeDialog());
    if (code == null || !mounted || _busy) return;
    if (!code.startsWith('GYM1.')) {
      setState(() => _hint = 'Bu bir salon giriş kodu değil.');
      return;
    }
    _lastCode = code;
    _submit(code);
  }

  @override
  Widget build(BuildContext context) {
    final result = _result;
    return Scaffold(
      backgroundColor: Colors.black,
      appBar: AppBar(
        title: const Text('QR kodu okut'),
        backgroundColor: Colors.black,
        foregroundColor: Colors.white,
        actions: [
          IconButton(
            tooltip: 'Kodu elle gir',
            icon: const Icon(Icons.keyboard_outlined),
            onPressed: _busy ? null : _enterManually,
          ),
        ],
      ),
      body: Stack(
        fit: StackFit.expand,
        children: [
          MobileScanner(controller: _controller, onDetect: _onDetect),
          if (result == null && !_busy)
            Align(
              alignment: Alignment.bottomCenter,
              child: Padding(
                padding: const EdgeInsets.all(32),
                child: Text(
                  _hint ?? 'Kapıdaki ekranda görünen QR kodu çerçeveye alın',
                  textAlign: TextAlign.center,
                  style: const TextStyle(color: Colors.white, fontSize: 18),
                ),
              ),
            ),
          if (_busy && result == null) const ColoredBox(color: Colors.black54, child: Center(child: CircularProgressIndicator())),
          if (result != null) _ResultPanel(result: result, onRetry: _retry),
        ],
      ),
    );
  }
}

class _ManualCodeDialog extends StatefulWidget {
  const _ManualCodeDialog();

  @override
  State<_ManualCodeDialog> createState() => _ManualCodeDialogState();
}

class _ManualCodeDialogState extends State<_ManualCodeDialog> {
  final _controller = TextEditingController();

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: const Text('Kodu elle gir'),
      content: TextField(
        controller: _controller,
        autofocus: true,
        decoration: const InputDecoration(
          labelText: 'Kapı ekranındaki kod',
          hintText: 'GYM1.…',
          border: OutlineInputBorder(),
        ),
        onSubmitted: (_) => Navigator.of(context).pop(_controller.text.trim()),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.of(context).pop(), child: const Text('Vazgeç')),
        FilledButton(
          onPressed: () => Navigator.of(context).pop(_controller.text.trim()),
          child: const Text('Gönder'),
        ),
      ],
    );
  }
}

class _ResultPanel extends StatelessWidget {
  const _ResultPanel({required this.result, required this.onRetry});

  final ScanResult result;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    return ColoredBox(
      color: result.ok ? const Color(0xFF16A34A) : const Color(0xFFDC2626),
      child: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(32),
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Icon(result.ok ? Icons.check_circle_outline : Icons.block, size: 120, color: Colors.white),
              const SizedBox(height: 24),
              Text(
                result.message,
                textAlign: TextAlign.center,
                style: const TextStyle(color: Colors.white, fontSize: 26, fontWeight: FontWeight.bold),
              ),
              if (result.gymName != null) ...[
                const SizedBox(height: 12),
                Text(result.gymName!, style: const TextStyle(color: Colors.white70, fontSize: 18)),
              ],
              if (!result.ok) ...[
                const SizedBox(height: 32),
                FilledButton(
                  style: FilledButton.styleFrom(backgroundColor: Colors.white, foregroundColor: Colors.black),
                  onPressed: onRetry,
                  child: const Padding(padding: EdgeInsets.symmetric(horizontal: 16, vertical: 12), child: Text('Tekrar dene')),
                ),
                TextButton(
                  onPressed: () => Navigator.of(context).pop(),
                  child: const Text('Kapat', style: TextStyle(color: Colors.white)),
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }
}
