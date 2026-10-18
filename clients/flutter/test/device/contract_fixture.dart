import 'dart:convert';
import 'dart:io';

typedef ContractCase = Map<String, dynamic>;
typedef ContractAdapter = Future<void> Function(ContractCase contractCase);

// `flutter test` runs with the package directory as the working directory.
const String fixturePath = '../../tests/fixtures/device-contract/v1/cases.json';

Map<String, dynamic> loadFixture() =>
    jsonDecode(File(fixturePath).readAsStringSync()) as Map<String, dynamic>;

List<ContractCase> loadCases() =>
    (loadFixture()['cases'] as List<dynamic>).cast<Map<String, dynamic>>();
