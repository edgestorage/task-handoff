#import <React/RCTBridgeModule.h>
#import <React/RCTEventEmitter.h>

@interface RCT_EXTERN_MODULE(TaskHandoffCarPlay, RCTEventEmitter)

RCT_EXTERN_METHOD(update:(NSDictionary *)payload)
RCT_EXTERN_METHOD(isConnected:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

@end
