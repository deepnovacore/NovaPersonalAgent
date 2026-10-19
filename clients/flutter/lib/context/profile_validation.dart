/// Structured feedback from host validation. Never attach source/model prose.
class ProfileValidationFailure extends StateError {
  ProfileValidationFailure(super.message, this.detail);
  final Map<String, dynamic> detail;
}

/// Only fixed checks and schema paths may enter Timeline repair diagnostics.
/// Other profile feedback may carry citation IDs; it must not be copied here.
Map<String, String>? safeTimelineValidationDetail(
  ProfileValidationFailure error,
) {
  const reasons = {
    'entry_schema',
    'entry_key_type',
    'entry_key_format',
    'entry_key_duplicate',
    'entry_text_type',
    'entry_text_empty',
    'entry_text_too_long',
    'evidence_ids_type',
    'evidence_ids_empty',
    'evidence_id_unknown',
    'timeline_refs_cross_topic',
    'brief_schema',
    'brief_text_type',
    'brief_text_too_long',
    'brief_text_empty',
    'facts_type',
    'facts_empty',
    'facts_too_many',
    'next_steps_type',
    'next_steps_too_many',
    'fact_schema',
    'fact_ref_type',
    'fact_ref_not_cited',
    'fact_source_missing',
    'fact_source_text_type',
    'fact_quote_type',
    'fact_quote_empty',
    'fact_quote_too_long',
    'fact_quote_not_exact',
    'fact_quote_sensitive',
    'next_step_schema',
    'brief_text_mismatch',
    'todo_text_too_long',
    'internal_alias',
    'local_address',
    'time_ref_not_cited',
  };
  final reason = error.detail['reason'], path = error.detail['path'];
  final schemaPath = RegExp(
    r'^timeline(?:\[[0-9]+\](?:\.(?:key|text|time_ref|evidence_ids(?:\[[0-9]+\])?|brief(?:\.(?:title|status_label|why_now|uncertainty|facts(?:\[[0-9]+\](?:\.(?:text|ref|quote))?)?|next_steps(?:\[[0-9]+\](?:\.(?:title|detail))?)?))?))?)?$',
  );
  if (reason is! String ||
      !reasons.contains(reason) ||
      path is! String ||
      !schemaPath.hasMatch(path)) {
    return null;
  }
  return {'reason': reason, 'path': path};
}
