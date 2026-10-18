#import "NovaShellRuntime.h"
#import "ISHKernel.h"
#import "ISHShellExecutor.h"
#include "ish/tools/fakefs.h"
#include <stdatomic.h>
#include <signal.h>

static atomic_int novaActivePID;
static atomic_bool novaCancelled;
@implementation NovaShellRuntime
+ (BOOL)prepareArchive:(NSString *)archive root:(NSString *)root workspace:(NSString *)workspace error:(NSError **)error {
    NSFileManager *fm = NSFileManager.defaultManager;
    if (!ISHKernel.shared.isBooted) {
        NSString *database = [root stringByAppendingPathComponent:@"meta.db"];
        if (![fm fileExistsAtPath:database]) {
            if ([fm fileExistsAtPath:root]) {
                if (error) *error = [NSError errorWithDomain:@"NovaRuntime" code:1 userInfo:@{NSLocalizedDescriptionKey:@"Existing runtime requires recovery; it was not overwritten."}];
                return NO;
            }
            if (![fm createDirectoryAtPath:root.stringByDeletingLastPathComponent withIntermediateDirectories:YES attributes:nil error:error]) return NO;
            NSString *staging = [root.stringByDeletingLastPathComponent stringByAppendingPathComponent:[@".install-" stringByAppendingString:NSUUID.UUID.UUIDString]];
            struct fakefsify_error detail = {0};
            if (!fakefs_import(archive.fileSystemRepresentation, staging.fileSystemRepresentation, &detail, (struct progress){0})) {
                if (error) *error = [NSError errorWithDomain:@"NovaRuntime" code:2 userInfo:@{NSLocalizedDescriptionKey:@"Could not install bundled Linux filesystem."}];
                free(detail.message); [fm removeItemAtPath:staging error:nil]; return NO;
            }
            if (![fm moveItemAtPath:staging toPath:root error:error]) return NO;
        }
        if (![fm createDirectoryAtPath:workspace withIntermediateDirectories:YES attributes:nil error:error]) return NO;
        int boot = [ISHKernel.shared bootWithRootPath:root];
        if (boot != 0) {
            if (error) *error = [NSError errorWithDomain:@"NovaRuntime" code:boot userInfo:@{NSLocalizedDescriptionKey:@"Linux kernel boot failed."}]; return NO;
        }
        int mounted = [ISHKernel.shared bindMountPath:@"/workspace" toHostPath:workspace];
        if (mounted != 0) {
            if (error) *error = [NSError errorWithDomain:@"NovaRuntime" code:mounted userInfo:@{NSLocalizedDescriptionKey:@"Could not mount workspace."}]; return NO;
        }
    }
    return YES;
}
+ (NSDictionary<NSString *, id> *)execute:(NSString *)command timeout:(NSTimeInterval)timeout {
    atomic_store(&novaCancelled, false);
    dispatch_semaphore_t done = dispatch_semaphore_create(0);
    __block ISHShellExecutionResult *result;
    NSString *wrapped = [@"cd /workspace && " stringByAppendingString:command];
    int pid = [ISHShellExecutor executeCommand:wrapped lineCallback:^(NSString *line, BOOL isStdErr) {
        [NSNotificationCenter.defaultCenter postNotificationName:@"NovaRuntimeOutput" object:nil userInfo:@{@"characters":@(line.length), @"stderr":@(isStdErr)}];
    } completion:^(ISHShellExecutionResult *value) { result = value; dispatch_semaphore_signal(done); }];
    if (pid < 0) return @{@"status":@"failed", @"error":@"process_creation_failed", @"exit_code":@(pid)};
    atomic_store(&novaActivePID, pid);
    if (atomic_load(&novaCancelled)) [ISHShellExecutor killProcessGroup:pid];
    BOOL expired = dispatch_semaphore_wait(done, dispatch_time(DISPATCH_TIME_NOW, (int64_t)(timeout * NSEC_PER_SEC))) != 0;
    if (expired) { [ISHShellExecutor killProcessGroup:pid]; [ISHShellExecutor finalizeTimedOutPid:pid]; }
    atomic_store(&novaActivePID, 0);
    NSString *output = result.output ?: @"", *errors = result.errorOutput ?: @"";
    BOOL uncertain = expired || atomic_load(&novaCancelled) || result.error != ISHShellExecutorErrorNone;
    return @{@"status": uncertain ? @"outcome_unknown" : @"completed", @"exit_code": result ? @(result.exitCode) : NSNull.null,
        @"stdout":[output substringToIndex:MIN(output.length, 128 * 1024)], @"stderr":[errors substringToIndex:MIN(errors.length, 128 * 1024)],
        @"timed_out":@(expired), @"cancelled":@(atomic_load(&novaCancelled)), @"duration":@(result.duration)};
}
+ (void)cancel {
    atomic_store(&novaCancelled, true); int pid = atomic_load(&novaActivePID);
    if (pid > 0) { [ISHShellExecutor killProcessGroup:pid]; [ISHShellExecutor finalizeTimedOutPid:pid]; }
}
@end
