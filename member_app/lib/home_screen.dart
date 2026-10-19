import 'package:flutter/material.dart';

import 'api.dart';
import 'scan_screen.dart';

class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key, required this.api, required this.onLogout});

  final ApiClient api;
  final VoidCallback onLogout;

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  Profile? _profile;
  String? _error;
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _refresh();
  }

  Future<void> _refresh() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final profile = await widget.api.me();
      if (mounted) setState(() => _profile = profile);
    } on ApiException catch (e) {
      if (e.unauthorized) return widget.onLogout();
      if (mounted) setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _openScanner() async {
    final result = await Navigator.of(context).push<String>(
      MaterialPageRoute(builder: (_) => ScanScreen(api: widget.api)),
    );
    if (result == ScanScreen.unauthorized) return widget.onLogout();
    _refresh();
  }

  static String _date(DateTime d) =>
      '${d.day.toString().padLeft(2, '0')}.${d.month.toString().padLeft(2, '0')}.${d.year}';

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final profile = _profile;
    return Scaffold(
      appBar: AppBar(
        title: const Text('GYM Enter'),
        actions: [
          IconButton(tooltip: 'Çıkış yap', icon: const Icon(Icons.logout), onPressed: widget.onLogout),
        ],
      ),
      body: RefreshIndicator(
        onRefresh: _refresh,
        child: ListView(
          physics: const AlwaysScrollableScrollPhysics(),
          padding: const EdgeInsets.all(20),
          children: [
            if (_loading && profile == null) const Padding(
              padding: EdgeInsets.only(top: 80),
              child: Center(child: CircularProgressIndicator()),
            ),
            if (_error != null) _ErrorCard(message: _error!, onRetry: _refresh),
            if (profile != null) ...[
              Text('Merhaba ${profile.name}', style: theme.textTheme.headlineSmall),
              const SizedBox(height: 16),
              if (profile.memberships.isEmpty)
                const _NoGymCard()
              else
                for (final m in profile.memberships)
                  Padding(
                    padding: const EdgeInsets.only(bottom: 12),
                    child: _MembershipCard(membership: m, formatDate: _date),
                  ),
              const SizedBox(height: 12),
              FilledButton.icon(
                onPressed: _openScanner,
                icon: const Icon(Icons.qr_code_scanner),
                label: const Padding(
                  padding: EdgeInsets.symmetric(vertical: 18),
                  child: Text('Kapıdaki QR kodu okut', style: TextStyle(fontSize: 18)),
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

/// Üye olunan salonlardan birinin üyelik kartı.
class _MembershipCard extends StatelessWidget {
  const _MembershipCard({required this.membership, required this.formatDate});

  final GymMembership membership;
  final String Function(DateTime) formatDate;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final ms = membership;

    if (!ms.active) {
      final reason = !ms.enabled
          ? 'Bu salondaki üyeliğiniz devre dışı. Salonla iletişime geçin.'
          : ms.endsAt != null
              ? 'Üyeliğiniz ${formatDate(ms.endsAt!)} tarihinde bitti. Yenilemek için salona başvurun.'
              : 'Henüz bir paketiniz yok. Paket tanımlatmak için salona başvurun.';
      return Card(
        color: theme.colorScheme.errorContainer,
        child: ListTile(
          leading: Icon(Icons.warning_amber_rounded, color: theme.colorScheme.onErrorContainer),
          title: Text(ms.gymName, style: TextStyle(color: theme.colorScheme.onErrorContainer)),
          subtitle: Text(reason, style: TextStyle(color: theme.colorScheme.onErrorContainer)),
        ),
      );
    }

    final expiringSoon = ms.daysLeft <= 7;
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(20),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(ms.gymName, style: theme.textTheme.titleLarge),
            const SizedBox(height: 4),
            Text(ms.plan ?? '', style: theme.textTheme.bodyMedium),
            const SizedBox(height: 8),
            Text('${ms.daysLeft} gün kaldı',
                style: theme.textTheme.headlineMedium?.copyWith(
                  color: expiringSoon ? theme.colorScheme.error : theme.colorScheme.primary,
                )),
            const SizedBox(height: 4),
            if (ms.endsAt != null) Text('Bitiş: ${formatDate(ms.endsAt!)}', style: theme.textTheme.bodyMedium),
          ],
        ),
      ),
    );
  }
}

class _NoGymCard extends StatelessWidget {
  const _NoGymCard();

  @override
  Widget build(BuildContext context) {
    return const Card(
      child: ListTile(
        leading: Icon(Icons.info_outline),
        title: Text('Henüz bir salona üye değilsiniz'),
        subtitle: Text('Salonunuza bu e-posta adresiyle kayıt yaptırın; üyeliğiniz burada görünür.'),
      ),
    );
  }
}

class _ErrorCard extends StatelessWidget {
  const _ErrorCard({required this.message, required this.onRetry});

  final String message;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          children: [
            Text(message, textAlign: TextAlign.center),
            const SizedBox(height: 12),
            OutlinedButton(onPressed: onRetry, child: const Text('Tekrar dene')),
          ],
        ),
      ),
    );
  }
}
