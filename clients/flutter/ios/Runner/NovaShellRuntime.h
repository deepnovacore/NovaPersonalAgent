#import <Foundation/Foundation.h>
NS_ASSUME_NONNULL_BEGIN
@interface NovaShellRuntime : NSObject
+ (BOOL)prepareArchive:(NSString *)archive root:(NSString *)root workspace:(NSString *)workspace error:(NSError **)error;
+ (void)executeID:(NSString *)identifier command:(NSString *)command cwd:(NSString *)cwd environment:(NSDictionary<NSString *, NSString *> *)environment timeout:(NSTimeInterval)timeout completion:(void (^)(NSDictionary<NSString *, id> *))completion;
+ (BOOL)cancelID:(NSString *)identifier;
@end
NS_ASSUME_NONNULL_END
