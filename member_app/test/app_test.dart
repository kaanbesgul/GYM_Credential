import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:member_app/api.dart';
import 'package:member_app/login_screen.dart';
import 'package:member_app/storage.dart';

void main() {
  group('ApiClient.normalizeBaseUrl', () {
    test('şema ve sondaki eğik çizgiyi düzeltir', () {
      expect(ApiClient.normalizeBaseUrl('192.168.1.5:3000/'), 'http://192.168.1.5:3000');
      expect(ApiClient.normalizeBaseUrl('  http://gym.local:3000  '), 'http://gym.local:3000');
      expect(ApiClient.normalizeBaseUrl('https://gym.example.com//'), 'https://gym.example.com');
    });

    test('boş veya geçersiz adresi reddeder', () {
      expect(() => ApiClient.normalizeBaseUrl(''), throwsFormatException);
      expect(() => ApiClient.normalizeBaseUrl('http://'), throwsFormatException);
    });
  });

  group('Profile.fromJson', () {
    test('iki salona üye kişinin ayrı üyeliklerini okur', () {
      final profile = Profile.fromJson({
        'name': 'Ali',
        'email': 'ali@test.local',
        'memberships': [
          {
            'gymId': 1, 'gymName': 'Salon Bir', 'enabled': true, 'active': true,
            'plan': 'Aylık', 'endsAt': '2026-11-17T20:25:42.813Z', 'daysLeft': 30,
          },
          {
            'gymId': 2, 'gymName': 'Salon İki', 'enabled': true, 'active': false,
            'plan': '3 Aylık', 'endsAt': '2026-01-01T00:00:00.000Z', 'daysLeft': 0,
          },
        ],
        'gyms': [],
      });
      expect(profile.memberships.length, 2);
      expect(profile.memberships[0].gymName, 'Salon Bir');
      expect(profile.memberships[0].active, isTrue);
      expect(profile.memberships[0].daysLeft, 30);
      expect(profile.memberships[1].gymName, 'Salon İki');
      expect(profile.memberships[1].active, isFalse);
    });

    test('hiç salonu ve paketi olmayan kişiyi okur', () {
      final empty = Profile.fromJson({'name': 'Veli', 'email': 'veli@test.local', 'memberships': []});
      expect(empty.memberships, isEmpty);

      final noPlan = Profile.fromJson({
        'name': 'Can',
        'email': 'can@test.local',
        'memberships': [
          {'gymId': 1, 'gymName': 'Salon Bir', 'enabled': true, 'active': false, 'plan': null, 'endsAt': null, 'daysLeft': 0},
        ],
      });
      expect(noPlan.memberships.single.plan, isNull);
      expect(noPlan.memberships.single.endsAt, isNull);
    });
  });

  testWidgets('giriş ekranı e-posta ve şifreyi doğrular', (tester) async {
    await tester.pumpWidget(MaterialApp(
      home: LoginScreen(
        store: SessionStore(),
        initialServerUrl: SessionStore.defaultServerUrl,
        onLoggedIn: (_, _) {},
      ),
    ));

    expect(find.text('Giriş Yap'), findsOneWidget);
    await tester.tap(find.text('Giriş Yap'));
    await tester.pump();
    expect(find.text('Geçerli bir e-posta girin'), findsOneWidget);
    expect(find.text('Şifrenizi girin'), findsOneWidget);
  });
}
