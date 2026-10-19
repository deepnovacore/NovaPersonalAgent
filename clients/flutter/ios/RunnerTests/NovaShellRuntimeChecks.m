#import <Foundation/Foundation.h>
#import "NovaShellRuntime.h"
#import "ISHKernel.h"
#import "ISHShellExecutor.h"
#include <unistd.h>

// The lifecycle checks isolate the host wrapper; GuestChecks runs the real emulator.
static int launches;
@implementation ISHKernel
+ (ISHKernel *)shared { static ISHKernel *k; if (!k) k = ISHKernel.new; return k; }
- (BOOL)isBooted { return YES; }
- (int)bootWithRootPath:(NSString *)path { return 0; }
- (int)bindMountPath:(NSString *)path toHostPath:(NSString *)host { return 0; }
@end
@implementation ISHShellExecutor
+ (int)executeExecutable:(NSString *)executable arguments:(NSArray *)arguments environment:(NSDictionary *)environment lineCallback:(ISHShellLineCallback)line completion:(ISHShellCompletionCallback)completion { launches++; return -1; }
+ (void)killProcessGroup:(int)pid {}
+ (void)finalizeTimedOutPid:(int)pid {}
@end
int main(int argc, const char **argv) { @autoreleasepool {
    NSCAssert(argc == 2,@"Expected external test root");
    NSString *base = [NSString stringWithUTF8String:argv[1]];
    NSFileManager *fm = NSFileManager.defaultManager;
    NSString *workspace = [base stringByAppendingPathComponent:@"workspace"], *outside = [base stringByAppendingPathComponent:@"outside"];
    NSString *root = [base stringByAppendingPathComponent:@"root"];
    for (NSString *p in @[workspace,outside,root]) [fm createDirectoryAtPath:p withIntermediateDirectories:YES attributes:nil error:nil];
    [@"test" writeToFile:[root stringByAppendingPathComponent:@"meta.db"] atomically:YES encoding:NSUTF8StringEncoding error:nil];
    NSError *error;
    NSCAssert([NovaShellRuntime prepareArchive:@"unused" root:root workspace:workspace error:&error],@"prepare failed");
    NSCAssert(![NovaShellRuntime prepareArchive:@"unused" root:root workspace:outside error:&error],@"changed root accepted");
    NSCAssert(![NovaShellRuntime cancelID:@"unknown"],@"unknown cancellation accepted");
    [fm createSymbolicLinkAtPath:[workspace stringByAppendingPathComponent:@".nova"] withDestinationPath:outside error:nil];
    __block BOOL done = NO;
    [NovaShellRuntime executeID:@"symlink" command:@"echo secret" cwd:@"/workspace" environment:@{} timeout:1 completion:^(NSDictionary *r) { done = YES; }];
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:3];
    while (!done && deadline.timeIntervalSinceNow > 0) [[NSRunLoop currentRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.01]];
    NSCAssert(done,@"wrapper did not return");
    NSCAssert(launches == 0,@"launched through symlinked metadata directory");
    NSCAssert([fm contentsOfDirectoryAtPath:outside error:nil].count == 0,@"native output escaped workspace through symlink");
    puts("NovaShellRuntimeChecks passed");
} return 0; }
