import 'package:flutter/material.dart';

import 'api.dart';
import 'home_screen.dart';
import 'login_screen.dart';
import 'storage.dart';

void main() => runApp(const MemberApp());

class MemberApp extends StatelessWidget {
  const MemberApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'GYM Enter',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        useMaterial3: true,
        colorScheme: ColorScheme.fromSeed(seedColor: const Color(0xFF16A34A)),
      ),
      home: const Bootstrap(),
    );
  }
}

/// Açılışta kayıtlı oturumu okur; varsa ana ekrana, yoksa giriş ekranına gider.
class Bootstrap extends StatefulWidget {
  const Bootstrap({super.key});

  @override
  State<Bootstrap> createState() => _BootstrapState();
}

class _BootstrapState extends State<Bootstrap> {
  final _store = SessionStore();
  bool _loading = true;
  String? _token;
  String _serverUrl = SessionStore.defaultServerUrl;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final token = await _store.readToken();
    final serverUrl = await _store.readServerUrl();
    if (!mounted) return;
    setState(() {
      _token = token;
      _serverUrl = serverUrl;
      _loading = false;
    });
  }

  Future<void> _logout() async {
    await _store.clearToken();
    if (!mounted) return;
    setState(() => _token = null);
  }

  void _loggedIn(String token, String serverUrl) {
    setState(() {
      _token = token;
      _serverUrl = serverUrl;
    });
  }

  @override
  Widget build(BuildContext context) {
    if (_loading) {
      return const Scaffold(body: Center(child: CircularProgressIndicator()));
    }
    final token = _token;
    if (token == null) {
      return LoginScreen(store: _store, initialServerUrl: _serverUrl, onLoggedIn: _loggedIn);
    }
    return HomeScreen(api: ApiClient(baseUrl: _serverUrl, token: token), onLogout: _logout);
  }
}
