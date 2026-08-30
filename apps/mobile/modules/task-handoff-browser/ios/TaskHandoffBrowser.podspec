require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'TaskHandoffBrowser'
  s.version        = package['version']
  s.summary        = 'Instance-scoped native browser tunnel for TaskHandoff mobile'
  s.description    = 'Owns the native WebView, loopback SOCKS proxy, and Browser Tunnel data plane.'
  s.license        = { :type => 'Apache-2.0' }
  s.author         = 'TaskHandoff'
  s.homepage       = 'https://taskhandoff.dev'
  s.platforms      = { :ios => '16.4' }
  s.source         = { :path => '.' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.frameworks = 'CryptoKit', 'Network', 'Security', 'WebKit'
  s.source_files = '*.{h,m,mm,swift,hpp,cpp}'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
end
