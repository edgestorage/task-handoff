require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'TaskHandoffRemoteDesktop'
  s.version        = package['version']
  s.summary        = 'Native remote desktop decoder surface for TaskHandoff mobile'
  s.description    = 'Decodes the remote desktop WebSocket fallback and renders hardware-backed video.'
  s.license        = { :type => 'Apache-2.0' }
  s.author         = 'TaskHandoff'
  s.homepage       = 'https://taskhandoff.dev'
  s.platforms      = { :ios => '16.4' }
  s.source         = { :path => '.' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.frameworks = 'AVFoundation', 'CoreMedia', 'CoreVideo', 'VideoToolbox'
  s.source_files = '*.{h,m,mm,swift}'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
end
