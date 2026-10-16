import 'dart:async';
import 'dart:convert';
import 'dart:io';

class AgentFailure implements Exception {
  const AgentFailure(this.code);
  final String code;
  @override
  String toString() => code;
}

class ModelConfiguration {
  ModelConfiguration({
    required this.endpoint,
    required this.model,
    required this.key,
  }) {
    final uri = Uri.tryParse(endpoint);
    final host = uri?.host.replaceAll('[', '').replaceAll(']', '');
    final loopback =
        host == 'localhost' ||
        (host != null && InternetAddress.tryParse(host)?.isLoopback == true);
    if (uri == null ||
        uri.host.isEmpty ||
        uri.userInfo.isNotEmpty ||
        uri.hasQuery ||
        uri.hasFragment ||
        !(uri.scheme == 'https' || (uri.scheme == 'http' && loopback)) ||
        model.trim().isEmpty ||
        model.length > 200 ||
        key.isEmpty ||
        key.length > 8192 ||
        key.contains('\n') ||
        key.contains('\r')) {
      throw const AgentFailure('invalid_model_settings');
    }
  }
  final String endpoint, model, key;
  Map<String, dynamic> toJson() => {
    'endpoint': endpoint,
    'model': model,
    'key': key,
  };
}

/// One client per turn: cancellation closes connections, including a pending open.
class ModelClient {
  ModelClient({
    this.timeout = const Duration(seconds: 60),
    this.maxBytes = 1024 * 1024,
  });
  final Duration timeout;
  final int maxBytes;
  HttpClient? _http;
  bool _cancelled = false;
  void cancel() {
    _cancelled = true;
    _http?.close(force: true);
  }

  Stream<Map<String, dynamic>> stream(
    ModelConfiguration configuration,
    List<Map<String, dynamic>> messages, {
    List<Map<String, dynamic>> tools = const [],
  }) async* {
    if (_cancelled) throw const AgentFailure('cancelled');
    final http = _http = HttpClient()..connectionTimeout = timeout;
    var expired = false;
    final timer = Timer(timeout, () {
      expired = true;
      http.close(force: true);
    });
    try {
      final request = await http.postUrl(Uri.parse(configuration.endpoint));
      request.followRedirects = false;
      request.headers.contentType = ContentType.json;
      request.headers.set('Authorization', 'Bearer ${configuration.key}');
      request.headers.set('Accept', 'text/event-stream');
      request.write(
        jsonEncode({
          'model': configuration.model,
          'stream': true,
          'messages': messages,
          if (tools.isNotEmpty) 'tools': tools,
        }),
      );
      final response = await request.close();
      if (response.statusCode != 200) {
        throw const AgentFailure('model_request_failed');
      }
      if (response.headers.contentType?.mimeType != 'text/event-stream') {
        throw const AgentFailure('model_stream_required');
      }
      var size = 0;
      final bytes = response.map((chunk) {
        size += chunk.length;
        if (size > maxBytes) {
          throw const AgentFailure('model_response_too_large');
        }
        return chunk;
      });
      var data = <String>[];
      await for (final line
          in utf8.decoder.bind(bytes).transform(const LineSplitter())) {
        if (_cancelled) throw const AgentFailure('cancelled');
        if (expired) throw const AgentFailure('model_timeout');
        if (line.isEmpty) {
          if (data.isEmpty) continue;
          final event = data.join('\n');
          data = [];
          if (event == '[DONE]') return;
          final root = jsonDecode(event) as Map<String, dynamic>;
          if (root['error'] != null) {
            throw const AgentFailure('model_request_failed');
          }
          final choices = root['choices'] as List;
          if (choices.isEmpty) continue;
          if (choices.length != 1) {
            throw const AgentFailure('invalid_model_response');
          }
          yield Map<String, dynamic>.from(
            (choices.single as Map)['delta'] as Map,
          );
        } else if (line.startsWith('data:')) {
          data.add(line.substring(5).replaceFirst(RegExp(r'^ '), ''));
        }
      }
      throw const AgentFailure('model_stream_interrupted');
    } on AgentFailure {
      rethrow;
    } catch (_) {
      throw AgentFailure(
        _cancelled
            ? 'cancelled'
            : expired
            ? 'model_timeout'
            : 'model_request_failed',
      );
    } finally {
      timer.cancel();
      http.close(force: true);
      _http = null;
    }
  }
}
