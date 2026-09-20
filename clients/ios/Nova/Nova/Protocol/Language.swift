import Foundation

enum L10n {
    /// `languages` is autoclosured: a saved preference returns before the system list is ever read.
    static func initialLanguage(defaults: UserDefaults = .standard,
                                languages: @autoclosure () -> [String] = Locale.preferredLanguages) -> String {
        if let saved = defaults.string(forKey: "nova.language"), ["zh-CN", "en"].contains(saved) { return saved }
        let first = (languages().first ?? "").lowercased().replacingOccurrences(of: "_", with: "-")
        let language = first == "zh" || first.hasPrefix("zh-") ? "zh-CN" : "en"
        defaults.set(language, forKey: "nova.language")
        return language
    }

    // The pattern is a constant, and each .lproj bundle is immutable once located. The language
    // itself is never cached: it must keep following the stored preference.
    private static let placeholder = try! NSRegularExpression(pattern: #"\{(\d+)\}"#)
    private static let bundles: [String: Bundle] = ["en", "zh-Hans"].reduce(into: [:]) { found, resource in
        if let bundle = Bundle.main.path(forResource: resource, ofType: "lproj").flatMap(Bundle.init(path:)) {
            found[resource] = bundle
        }
    }

    static func text(_ source: String, _ values: CustomStringConvertible...) -> String {
        let resource = initialLanguage() == "en" ? "en" : "zh-Hans"
        let bundle = bundles[resource] ?? .main
        let template = bundle.localizedString(forKey: source, value: source, table: nil)
        // Substitute once so a user value containing {0} is never interpreted again.
        var result = template
        for match in placeholder.matches(in: template, range: NSRange(template.startIndex..., in: template)).reversed() {
            guard let indexRange = Range(match.range(at: 1), in: template), let index = Int(template[indexRange]), index < values.count,
                  let range = Range(match.range, in: result) else { continue }
            result.replaceSubrange(range, with: values[index].description)
        }
        return result
    }
}
