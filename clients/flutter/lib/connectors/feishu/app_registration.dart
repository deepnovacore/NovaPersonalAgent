part of 'auth.dart';

/// Official PersonalAgent device registration, independent of user read OAuth.
/// The phone receives credentials only after confirmation on the official page.
extension FeishuAppRegistration on FeishuAuth {
  Future<FeishuAuthorizationSession> beginAppRegistration(String brand) async {
    api.accounts(brand);
    if (configured || revocationPending) {
      throw const FeishuFailure('app_already_configured');
    }
    final generation = ++_generation;
    _registration = null;
    _pending = null;
    await _save({'version': 1, 'generation': generation}, generation);
    final response = await api.oauth('feishu', '/oauth/v1/app/registration', {
      'action': 'begin',
      'archetype': 'PersonalAgent',
      'auth_method': 'client_secret',
      'request_user_info': 'open_id tenant_brand',
    });
    _check(generation);
    final data = response.data;
    if (response.status != 200 ||
        data['error'] != null ||
        data['device_code'] is! String ||
        (data['device_code'] as String).isEmpty ||
        data['user_code'] is! String ||
        (data['user_code'] as String).isEmpty) {
      throw const FeishuFailure('registration_unavailable');
    }
    int positive(dynamic value, int fallback) =>
        value is int && value > 0 ? value : fallback;
    final expiry = positive(
      data['expire_in'],
      positive(data['expires_in'], 600),
    );
    final expires = now().add(Duration(seconds: expiry));
    _registration = {
      'generation': generation,
      'device_code': data['device_code'],
      'brand': 'feishu',
      'switched': false,
      'interval': positive(data['interval'], 5),
      'expires': expires,
      'next': now(),
      'polling': false,
    };
    return FeishuAuthorizationSession(
      Uri.https(api.openHost(brand), '/page/cli', {
        'user_code': data['user_code'],
      }),
      data['user_code'],
      expires,
    );
  }

  Future<void> cancelAppRegistration() async {
    if (_registration == null) return;
    _registration = null;
    final generation = ++_generation;
    await _save({..._data, 'generation': generation}, generation);
  }

  Future<bool> pollAppRegistration() async {
    final pending = _registration;
    if (pending == null) throw const FeishuFailure('registration_required');
    final generation = pending['generation'] as int;
    void check() {
      _check(generation);
      if (!now().isBefore(pending['expires'] as DateTime)) {
        _registration = null;
        throw const FeishuFailure('registration_expired');
      }
    }

    check();
    if (pending['polling'] == true ||
        now().isBefore(pending['next'] as DateTime)) {
      return false;
    }
    pending['polling'] = true;
    try {
      // Discovery may switch once between the two official issuing domains.
      for (var attempt = 0; attempt < 2; attempt++) {
        check();
        pending['next'] = now().add(
          Duration(seconds: pending['interval'] as int),
        );
        final response = await api.oauth(
          pending['brand'],
          '/oauth/v1/app/registration',
          {'action': 'poll', 'device_code': pending['device_code']},
        );
        check();
        final data = response.data;
        final tenant = data['user_info'] is Map
            ? data['user_info']['tenant_brand']
            : null;
        if (tenant != null && tenant != '' && tenant != pending['brand']) {
          if (!['feishu', 'lark'].contains(tenant) ||
              pending['switched'] == true) {
            _registration = null;
            throw const FeishuFailure('invalid_registration_brand');
          }
          pending['brand'] = tenant;
          pending['switched'] = true;
          continue;
        }
        final error = data['error'];
        if (error == 'authorization_pending') return false;
        if (error == 'slow_down') {
          pending['interval'] = ((pending['interval'] as int) + 5).clamp(5, 60);
          pending['next'] = now().add(
            Duration(seconds: pending['interval'] as int),
          );
          return false;
        }
        if (error != null || response.status != 200) {
          _registration = null;
          throw FeishuFailure(
            error == 'access_denied'
                ? 'registration_denied'
                : ['expired_token', 'invalid_grant'].contains(error)
                ? 'registration_expired'
                : 'registration_unavailable',
          );
        }
        final id = data['client_id'], secret = data['client_secret'];
        if (id == null || id == '' || secret == null || secret == '') {
          return false;
        }
        if (id is! String || secret is! String) {
          _registration = null;
          throw const FeishuFailure('invalid_registration_response');
        }
        // bindApp validates credentials and invalidates every earlier request.
        await bindApp(brand: pending['brand'], appId: id, secret: secret);
        _registration = null;
        return true;
      }
      return false;
    } finally {
      pending['polling'] = false;
    }
  }
}
