import AVFoundation
import CoreMedia
import ExpoModulesCore
import Foundation
import VideoToolbox

struct RemoteDesktopCodecConfig: Record {
  @Field var codec: String = ""
  @Field var width: Int = 0
  @Field var height: Int = 0
  @Field var fps: Int = 30
  @Field var bitrate: Int = 0
}

final class RemoteDesktopDecoderEngine {
  static let shared = RemoteDesktopDecoderEngine()

  private let lock = NSRecursiveLock()
  private weak var layer: AVSampleBufferDisplayLayer?
  private var config: RemoteDesktopCodecConfig?
  private var formatDescription: CMVideoFormatDescription?
  private var parameterSets: Data?
  private var lastTimestampUs: Int64 = 0
  private var generation: UInt64 = 0
  private var needsKeyframe = true
  private var lastReportedDimensions: (width: Int, height: Int)?
  var onError: ((String, String?) -> Void)?
  var onVideoDimensions: ((Int, Int) -> Void)?

  func attach(_ value: AVSampleBufferDisplayLayer) {
    lock.lock(); defer { lock.unlock() }
    if layer === value { return }
    generation &+= 1
    needsKeyframe = true
    lastReportedDimensions = nil
    layer = value
  }

  func detach(_ value: AVSampleBufferDisplayLayer) {
    lock.lock(); defer { lock.unlock() }
    if layer !== value { return }
    generation &+= 1
    needsKeyframe = true
    lastReportedDimensions = nil
    layer = nil
  }

  func configure(_ value: RemoteDesktopCodecConfig) {
    lock.lock(); defer { lock.unlock() }
    generation &+= 1
    needsKeyframe = true
    config = value
    formatDescription = nil
    parameterSets = nil
    lastTimestampUs = 0
    lastReportedDimensions = nil
    flushLayer()
  }

  func reset() {
    lock.lock(); defer { lock.unlock() }
    generation &+= 1
    needsKeyframe = true
    formatDescription = nil
    parameterSets = nil
    lastTimestampUs = 0
    lastReportedDimensions = nil
    flushLayer()
  }

  func close() {
    lock.lock(); defer { lock.unlock() }
    generation &+= 1
    needsKeyframe = true
    layer = nil
    config = nil
    formatDescription = nil
    parameterSets = nil
    lastTimestampUs = 0
    lastReportedDimensions = nil
  }

  func decode(_ data: Data, keyframe: Bool, timestampUs: Double) {
    lock.lock()
    let submission = prepare(data, keyframe: keyframe, timestampUs: timestampUs)
    lock.unlock()
    guard let (sample, targetLayer, revision) = submission else { return }
    // The native promise completes after this bounded main-thread submission,
    // not after scheduling another unbounded main.async closure. No lock is
    // held while waiting on main (attach/detach also take the lock).
    let submit = { [self] in
      lock.lock(); defer { lock.unlock() }
      guard generation == revision, let activeLayer = layer, activeLayer === targetLayer else { return }
      if activeLayer.status == .failed {
        activeLayer.flushAndRemoveImage()
        needsKeyframe = true
        report("REMOTE_DESKTOP_DECODER_FAILED", activeLayer.error?.localizedDescription)
        return
      }
      if activeLayer.requiresFlushToResumeDecoding {
        activeLayer.flushAndRemoveImage()
        needsKeyframe = true
      }
      guard (!needsKeyframe || keyframe), activeLayer.isReadyForMoreMediaData else {
        needsKeyframe = true
        report("REMOTE_DESKTOP_DECODER_BACKPRESSURE", nil)
        return
      }
      activeLayer.enqueue(sample)
      if keyframe { needsKeyframe = false }
    }
    if Thread.isMainThread { submit() }
    else { DispatchQueue.main.sync(execute: submit) }
  }

  private func prepare(_ data: Data, keyframe: Bool, timestampUs: Double)
    -> (CMSampleBuffer, AVSampleBufferDisplayLayer, UInt64)? {
    guard let config else { return nil }
    guard !data.isEmpty else { return nil }
    if !keyframe && (needsKeyframe || formatDescription == nil) { return nil }

    if keyframe {
      let nals = Self.annexBNals(data)
      guard let sets = Self.parameterSets(codec: config.codec, nals: nals),
            let description = Self.makeFormatDescription(codec: config.codec, sets: sets) else {
        return nil
      }
      if parameterSets != sets || formatDescription == nil {
        parameterSets = sets
        formatDescription = description
      }
    }
    guard let formatDescription, let layer else { return nil }
    reportDimensionsIfNeeded(formatDescription)
    let nals = Self.annexBNals(data)
    guard !nals.isEmpty else { return nil }
    var avcc = Data()
    for nal in nals {
      var length = UInt32(nal.count).bigEndian
      withUnsafeBytes(of: &length) { avcc.append(contentsOf: $0) }
      avcc.append(nal)
    }
    let timestamp = max(Int64(timestampUs.rounded()), lastTimestampUs + 1)
    lastTimestampUs = timestamp
    guard let sample = Self.makeSampleBuffer(avcc, formatDescription: formatDescription, timestampUs: timestamp, keyframe: keyframe) else {
      return nil
    }
    return (sample, layer, generation)
  }

  private func flushLayer() {
    guard let layer else { return }
    let revision = generation
    DispatchQueue.main.async { [weak self] in
      guard let self else { return }
      self.lock.lock(); defer { self.lock.unlock() }
      guard self.generation == revision, self.layer === layer else { return }
      layer.flushAndRemoveImage()
    }
  }

  private func report(_ code: String, _ message: String?) {
    onError?(code, message)
  }

  private func reportDimensionsIfNeeded(_ description: CMVideoFormatDescription) {
    let dimensions = CMVideoFormatDescriptionGetPresentationDimensions(
      description,
      usePixelAspectRatio: true,
      useCleanAperture: true
    )
    guard dimensions.width.isFinite, dimensions.height.isFinite else { return }
    let width = Int(dimensions.width.rounded())
    let height = Int(dimensions.height.rounded())
    guard width >= 2, height >= 2 else { return }
    if lastReportedDimensions?.width == width && lastReportedDimensions?.height == height { return }
    lastReportedDimensions = (width: width, height: height)
    onVideoDimensions?(width, height)
  }

  private static func parameterSets(codec: String, nals: [Data]) -> Data? {
    let hevc = codec.hasPrefix("hvc1") || codec.hasPrefix("hev1")
    let wanted: Set<Int> = hevc ? [32, 33, 34] : [7, 8]
    let selected = nals.filter { wanted.contains(nalType($0, h264: !hevc)) }
    guard !selected.isEmpty else { return nil }
    if !hevc && (!selected.contains(where: { nalType($0, h264: true) == 7 })
      || !selected.contains(where: { nalType($0, h264: true) == 8 })) {
      return nil
    }
    return selected.reduce(into: Data()) { result, nal in
      result.append(contentsOf: [0, 0, 0, 1])
      result.append(nal)
    }
  }

  private static func nalType(_ nal: Data, h264: Bool) -> Int {
    guard let first = nal.first else { return -1 }
    return h264 ? Int(first & 0x1f) : Int((first >> 1) & 0x3f)
  }

  private static func makeFormatDescription(codec: String, sets: Data) -> CMVideoFormatDescription? {
    let hevc = codec.hasPrefix("hvc1") || codec.hasPrefix("hev1")
    let nals = annexBNals(sets)
    var allocations: [UnsafeMutablePointer<UInt8>] = []
    defer { allocations.forEach { $0.deallocate() } }
    for nal in nals {
      let pointer = UnsafeMutablePointer<UInt8>.allocate(capacity: nal.count)
      nal.copyBytes(to: pointer, count: nal.count)
      allocations.append(pointer)
    }
    let pointers = allocations.map { UnsafePointer($0) }
    let sizes = nals.map(\.count)
    var description: CMVideoFormatDescription?
    let status: OSStatus = pointers.withUnsafeBufferPointer { pointerBuffer in
      sizes.withUnsafeBufferPointer { sizeBuffer in
        guard let pointerBase = pointerBuffer.baseAddress, let sizeBase = sizeBuffer.baseAddress else {
          return OSStatus(-12712)
        }
        if hevc {
          return CMVideoFormatDescriptionCreateFromHEVCParameterSets(
            allocator: kCFAllocatorDefault,
            parameterSetCount: nals.count,
            parameterSetPointers: pointerBase,
            parameterSetSizes: sizeBase,
            nalUnitHeaderLength: 4,
            extensions: nil,
            formatDescriptionOut: &description
          )
        }
        return CMVideoFormatDescriptionCreateFromH264ParameterSets(
          allocator: kCFAllocatorDefault,
          parameterSetCount: nals.count,
          parameterSetPointers: pointerBase,
          parameterSetSizes: sizeBase,
          nalUnitHeaderLength: 4,
          formatDescriptionOut: &description
        )
      }
    }
    return status == noErr ? description : nil
  }

  private static func makeSampleBuffer(_ data: Data, formatDescription: CMVideoFormatDescription, timestampUs: Int64, keyframe: Bool) -> CMSampleBuffer? {
    guard let memory = malloc(data.count) else { return nil }
    data.copyBytes(to: memory.assumingMemoryBound(to: UInt8.self), count: data.count)
    var blockBuffer: CMBlockBuffer?
    let blockStatus = CMBlockBufferCreateWithMemoryBlock(
      allocator: kCFAllocatorDefault,
      memoryBlock: memory,
      blockLength: data.count,
      blockAllocator: kCFAllocatorMalloc,
      customBlockSource: nil,
      offsetToData: 0,
      dataLength: data.count,
      flags: 0,
      blockBufferOut: &blockBuffer
    )
    guard blockStatus == noErr, let blockBuffer else { return nil }
    var timing = CMSampleTimingInfo(
      duration: .invalid,
      presentationTimeStamp: CMTime(value: timestampUs, timescale: 1_000_000),
      decodeTimeStamp: .invalid
    )
    var sampleSize = data.count
    var sampleBuffer: CMSampleBuffer?
    let status = CMSampleBufferCreateReady(
      allocator: kCFAllocatorDefault,
      dataBuffer: blockBuffer,
      formatDescription: formatDescription,
      sampleCount: 1,
      sampleTimingEntryCount: 1,
      sampleTimingArray: &timing,
      sampleSizeEntryCount: 1,
      sampleSizeArray: &sampleSize,
      sampleBufferOut: &sampleBuffer
    )
    guard status == noErr, let sampleBuffer else { return nil }
    if !keyframe {
      CMSetAttachment(sampleBuffer, key: kCMSampleAttachmentKey_NotSync, value: kCFBooleanTrue, attachmentMode: kCMAttachmentMode_ShouldPropagate)
    }
    CMSetAttachment(sampleBuffer, key: kCMSampleAttachmentKey_DisplayImmediately, value: kCFBooleanTrue, attachmentMode: kCMAttachmentMode_ShouldPropagate)
    return sampleBuffer
  }

  private static func annexBNals(_ data: Data) -> [Data] {
    let bytes = [UInt8](data)
    var starts: [(Int, Int)] = []
    var index = 0
    while index + 3 < bytes.count {
      if bytes[index] == 0 && bytes[index + 1] == 0 && bytes[index + 2] == 1 {
        starts.append((index, 3))
        index += 3
      } else if index + 4 < bytes.count && bytes[index] == 0 && bytes[index + 1] == 0 && bytes[index + 2] == 0 && bytes[index + 3] == 1 {
        starts.append((index, 4))
        index += 4
      } else {
        index += 1
      }
    }
    var result: [Data] = []
    for position in starts.indices {
      let (start, prefix) = starts[position]
      let begin = start + prefix
      let end = position + 1 < starts.count ? starts[position + 1].0 : bytes.count
      if end > begin { result.append(Data(bytes[begin..<end])) }
    }
    return result
  }
}
