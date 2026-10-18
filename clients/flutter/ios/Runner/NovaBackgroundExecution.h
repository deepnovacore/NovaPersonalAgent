#import <Foundation/Foundation.h>
#import <Flutter/Flutter.h>
NS_ASSUME_NONNULL_BEGIN
@interface NovaBackgroundExecution : NSObject
+ (void)installWithMessenger:(NSObject<FlutterBinaryMessenger> *)messenger;
+ (NSDictionary *)beginLease:(NSString *)identifier;
+ (void)progressLease:(NSString *)identifier units:(int64_t)units phase:(NSString *)phase;
+ (void)endLease:(NSString *)identifier success:(BOOL)success;
+ (BOOL)hasExecutionTime;
+ (void)modelTransferStarted:(NSString *)identifier;
+ (void)modelTransferFinished:(NSString *)identifier;
@end
NS_ASSUME_NONNULL_END
