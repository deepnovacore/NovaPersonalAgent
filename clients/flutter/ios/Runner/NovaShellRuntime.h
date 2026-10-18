#import <Foundation/Foundation.h>
NS_ASSUME_NONNULL_BEGIN
@interface NovaShellRuntime : NSObject
+ (BOOL)prepareArchive:(NSString *)archive root:(NSString *)root workspace:(NSString *)workspace error:(NSError **)error;
+ (NSDictionary<NSString *, id> *)execute:(NSString *)command timeout:(NSTimeInterval)timeout;
+ (void)cancel;
@end
NS_ASSUME_NONNULL_END
