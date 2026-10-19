import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:http/http.dart' as http;

class ApiException implements Exception {
  ApiException(this.message, {this.status});

  final String message;
  final int? status;

  /// Oturum süresi dolmuş veya hesap devre dışı: yeniden giriş gerekir.
  bool get unauthorized => status == 401;

  @override
  String toString() => message;
}

/// Üyenin bir salondaki durumu. Aynı kişi birden çok salona üye olabilir.
class GymMembership {
  GymMembership({
    required this.gymId,
    required this.gymName,
    required this.enabled,
    required this.active,
    required this.daysLeft,
    this.plan,
    this.endsAt,
  });

  final int gymId;
  final String gymName;

  /// Salon sahibi üyeliği devre dışı bırakmadıysa true
  final bool enabled;

  /// Şu an geçerli bir paketi var ve devre dışı değilse true
  final bool active;
  final int daysLeft;

  /// Süresi dolmuşsa en son paketin bilgisi; hiç paketi yoksa null
  final String? plan;
  final DateTime? endsAt;

  factory GymMembership.fromJson(Map<String, dynamic> json) {
    final endsAt = json['endsAt'] as String?;
    return GymMembership(
      gymId: (json['gymId'] as num).toInt(),
      gymName: json['gymName'] as String,
      enabled: json['enabled'] as bool? ?? true,
      active: json['active'] as bool? ?? false,
      daysLeft: (json['daysLeft'] as num?)?.toInt() ?? 0,
      plan: json['plan'] as String?,
      endsAt: endsAt == null ? null : DateTime.parse(endsAt).toLocal(),
    );
  }
}

class Profile {
  Profile({required this.name, required this.email, required this.memberships});

  final String name;
  final String email;
  final List<GymMembership> memberships;

  factory Profile.fromJson(Map<String, dynamic> json) {
    final list = json['memberships'];
    return Profile(
      name: json['name'] as String,
      email: json['email'] as String,
      memberships: list is List
          ? list.whereType<Map<String, dynamic>>().map(GymMembership.fromJson).toList()
          : <GymMembership>[],
    );
  }
}

class ScanResult {
  const ScanResult({required this.ok, required this.message, this.gymName});

  final bool ok;
  final String message;
  final String? gymName;
}

class ApiClient {
  ApiClient({required String baseUrl, this.token}) : baseUrl = normalizeBaseUrl(baseUrl);

  final String baseUrl;
  final String? token;

  /// "192.168.1.5:3000/" -> "http://192.168.1.5:3000"
  static String normalizeBaseUrl(String raw) {
    var url = raw.trim();
    if (url.isEmpty) throw const FormatException('Sunucu adresi boş.');
    if (!url.contains('://')) url = 'http://$url';
    url = url.replaceAll(RegExp(r'/+$'), '');
    final uri = Uri.tryParse(url);
    if (uri == null || uri.host.isEmpty) throw const FormatException('Sunucu adresi geçersiz.');
    return url;
  }

  /// Giriş yapar, oturum anahtarını döndürür.
  Future<String> login(String email, String password) async {
    final res = await _send('POST', '/api/auth/login', body: {'email': email, 'password': password});
    final data = _decode(res);
    if (res.statusCode == 200 && data['token'] is String) return data['token'] as String;
    throw ApiException(_errorMessage(data, 'Giriş yapılamadı.'), status: res.statusCode);
  }

  Future<Profile> me() async {
    final res = await _send('GET', '/api/me');
    final data = _decode(res);
    if (res.statusCode == 200) return Profile.fromJson(data);
    throw ApiException(_errorMessage(data, 'Bilgiler alınamadı.'), status: res.statusCode);
  }

  /// Kapıdaki QR'ı okutur. İş kuralı sonuçları (geçersiz kod, üyelik yok, bekleme…)
  /// hata olarak değil `ScanResult(ok: false)` olarak döner.
  Future<ScanResult> scan(String code) async {
    final res = await _send('POST', '/api/scan', body: {'code': code});
    final data = _decode(res);
    if (res.statusCode == 401) {
      throw ApiException(_errorMessage(data, 'Oturum geçersiz.'), status: 401);
    }
    if (data['ok'] is bool) {
      return ScanResult(
        ok: data['ok'] as bool,
        message: (data['message'] as String?) ?? (data['ok'] as bool ? 'Geçebilirsiniz.' : 'Giriş reddedildi.'),
        gymName: data['gymName'] as String?,
      );
    }
    throw ApiException(_errorMessage(data, 'Beklenmeyen sunucu yanıtı.'), status: res.statusCode);
  }

  Future<http.Response> _send(String method, String path, {Map<String, dynamic>? body}) async {
    final request = http.Request(method, Uri.parse('$baseUrl$path'))
      ..headers['content-type'] = 'application/json';
    if (token != null) request.headers['authorization'] = 'Bearer $token';
    if (body != null) request.body = jsonEncode(body);
    try {
      final streamed = await request.send().timeout(const Duration(seconds: 10));
      return await http.Response.fromStream(streamed);
    } on TimeoutException {
      throw ApiException('Sunucuya ulaşılamadı (zaman aşımı).');
    } on SocketException {
      throw ApiException('Sunucuya bağlanılamadı. Adresi ve Wi-Fi bağlantısını kontrol edin.');
    } on http.ClientException {
      throw ApiException('Sunucuya bağlanılamadı. Adresi ve Wi-Fi bağlantısını kontrol edin.');
    }
  }

  Map<String, dynamic> _decode(http.Response res) {
    try {
      final data = jsonDecode(utf8.decode(res.bodyBytes));
      return data is Map<String, dynamic> ? data : <String, dynamic>{};
    } catch (_) {
      return <String, dynamic>{};
    }
  }

  String _errorMessage(Map<String, dynamic> data, String fallback) =>
      (data['error'] as String?) ?? (data['message'] as String?) ?? fallback;
}
