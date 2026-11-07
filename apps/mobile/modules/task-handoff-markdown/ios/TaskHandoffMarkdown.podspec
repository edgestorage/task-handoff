Pod::Spec.new do |s|
  s.name           = 'TaskHandoffMarkdown'
  s.version        = '0.1.0'
  s.summary        = 'Native selectable Markdown for TaskHandoff mobile.'
  s.description    = 'Renders Markdown into one native attributed-text selection surface.'
  s.license        = { :type => 'Apache-2.0' }
  s.author         = 'TaskHandoff'
  s.homepage       = 'https://github.com/edgestorage/task-handoff'
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { :git => '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files = '**/*.swift'
end
