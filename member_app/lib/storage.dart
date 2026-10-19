import 'package:flutter_secure_storage/flutter_secure_storage.dart';

/// Oturum anahtarını (token) güvenli depoda, sunucu adresini yanında saklar.
class SessionStore {
  static const _storage = FlutterSecureStorage();
  static const _tokenKey = 'token';
  static const _serverKey = 'server_url';

  /// Geliştirme için örnek adres; ilk girişte kullanıcı kendi sunucusunu yazar.
  static const defaultServerUrl = 'http://192.168.1.10:3000';

  Future<String?> readToken() async {
    try {
      return await _storage.read(key: _tokenKey);
    } catch (_) {
      return null; // bozuk depo = oturum yok sayılır, kullanıcı tekrar giriş yapar
    }
  }

  Future<void> saveToken(String token) => _storage.write(key: _tokenKey, value: token);

  Future<void> clearToken() => _storage.delete(key: _tokenKey);

  Future<String> readServerUrl() async {
    try {
      return await _storage.read(key: _serverKey) ?? defaultServerUrl;
    } catch (_) {
      return defaultServerUrl;
    }
  }

  Future<void> saveServerUrl(String url) => _storage.write(key: _serverKey, value: url);
}
