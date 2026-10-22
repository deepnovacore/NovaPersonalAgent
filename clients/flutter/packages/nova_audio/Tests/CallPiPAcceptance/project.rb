# Generate an isolated device acceptance project using the locally installed xcodeproj gem.
require 'xcodeproj'
require 'fileutils'
output, team = ARGV
abort 'usage: project.rb /Volumes/<mounted disk>/<session>/pip-probe TEAM' unless output&.start_with?('/Volumes/') && team && !team.empty?
FileUtils.mkdir_p(output)
project = Xcodeproj::Project.new(File.join(output, 'PiPProbe.xcodeproj'))
app = project.new_target(:application, 'PiPProbe', :ios, '17.0')
tests = project.new_target(:ui_test_bundle, 'PiPProbeTests', :ios, '17.0')
tests.add_dependency(app)
sources = File.expand_path('../../ios/nova_audio/Sources/nova_audio', __dir__)
['CallPiPLifetime.swift', 'CallPictureInPicture.swift'].each do |file|
  app.add_file_references([project.main_group.new_file(File.join(sources, file))])
end
app.add_file_references([project.main_group.new_file(File.join(__dir__, 'Host.swift'))])
app.resources_build_phase.add_file_reference(project.main_group.new_file(File.join(sources, 'Resources/nova_orb_avatar.png')))
tests.add_file_references([project.main_group.new_file(File.join(__dir__, 'UITests.swift'))])
app.build_configurations.each do |config|
  config.build_settings.merge!({
    'PRODUCT_BUNDLE_IDENTIFIER' => 'com.nova.novaMobile.pipAcceptance',
    'GENERATE_INFOPLIST_FILE' => 'YES',
    'INFOPLIST_KEY_NSMicrophoneUsageDescription' => 'Local PiP acceptance only. Audio is discarded, never saved or sent.',
    'INFOPLIST_KEY_UILaunchScreen_Generation' => 'YES',
    'INFOPLIST_FILE' => File.join(output, 'Info.plist'),
    'TARGETED_DEVICE_FAMILY' => '1,2'
  })
end
Xcodeproj::Plist.write_to_path({'UIBackgroundModes' => ['audio']}, File.join(output, 'Info.plist'))
tests.build_configurations.each do |config|
  config.build_settings.merge!({'PRODUCT_BUNDLE_IDENTIFIER' => 'com.nova.novaMobile.pipAcceptance.tests', 'GENERATE_INFOPLIST_FILE' => 'YES', 'TEST_TARGET_NAME' => 'PiPProbe'})
end
[app, tests].each do |target|
  target.build_configurations.each do |config|
    config.build_settings.merge!({'DEVELOPMENT_TEAM' => team, 'CODE_SIGN_STYLE' => 'Automatic', 'SWIFT_VERSION' => '5.0', 'COMPILER_INDEX_STORE_ENABLE' => 'NO'})
  end
end
project.save
scheme = Xcodeproj::XCScheme.new
scheme.configure_with_targets(app, tests)
scheme.save_as(project.path, 'PiPProbe', true)
puts project.path
