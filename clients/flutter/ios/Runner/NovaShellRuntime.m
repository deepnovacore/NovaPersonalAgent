#import "NovaShellRuntime.h"
#import "ISHKernel.h"
#import "ISHShellExecutor.h"
#include <fcntl.h>
#include <unistd.h>
#include <sys/stat.h>
#include <errno.h>

@interface NovaShellRun : NSObject
@property int pid;
@property uint64_t ownership;
@property BOOL cancelled;
@property BOOL timedOut;
@property BOOL observedExit;
@property ISHShellExecutionResult *result;
@property dispatch_semaphore_t done;
@property dispatch_semaphore_t wake;
@end
@implementation NovaShellRun
@end

static NSMutableDictionary<NSString *, NovaShellRun *> *runs;
static NSString *mountedWorkspace;
static NSString *runtimeRoot;
static NSString *quote(NSString *s) { return [NSString stringWithFormat:@"'%@'", [s stringByReplacingOccurrencesOfString:@"'" withString:@"'\\''"]]; }
static NSError *failure(NSString *message) { return [NSError errorWithDomain:@"NovaRuntime" code:1 userInfo:@{NSLocalizedDescriptionKey:message}]; }

// Each host operation remains anchored to an opened directory, even if a guest
// replaces a path component concurrently. Never follow guest-created symlinks.
static int openDirectory(int parent, const char *name) {
    if (mkdirat(parent, name, 0700) < 0 && errno != EEXIST) return -1;
    return openat(parent, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
}
static NSString *decodeUTF8(NSData *data) {
    // Decode valid sequences independently; replace invalid/incomplete bytes.
    // A truncated final sequence must not corrupt all preceding Chinese text.
    const unsigned char *bytes = data.bytes;
    NSMutableString *text = NSMutableString.new;
    for (NSUInteger i = 0; i < data.length;) {
        unsigned char b = bytes[i];
        NSUInteger n = b < 0x80 ? 1 : (b >= 0xc2 && b <= 0xdf ? 2 : (b >= 0xe0 && b <= 0xef ? 3 : (b >= 0xf0 && b <= 0xf4 ? 4 : 0)));
        NSString *part = n && i + n <= data.length ? [[NSString alloc] initWithBytes:bytes+i length:n encoding:NSUTF8StringEncoding] : nil;
        [text appendString:part ?: @"\uFFFD"];
        i += part ? n : 1;
    }
    return text;
}

@implementation NovaShellRuntime
+ (void)initialize { if (self == NovaShellRuntime.class) runs = NSMutableDictionary.new; }
+ (BOOL)prepareArchive:(NSString *)archive root:(NSString *)root workspace:(NSString *)workspace error:(NSError **)error {
    @synchronized(self) {
        if (mountedWorkspace) {
            if ([mountedWorkspace isEqualToString:workspace] && [runtimeRoot isEqualToString:root]) return YES;
            if (error) *error = failure(@"space_runtime_restart_required"); return NO;
        }
        NSFileManager *fm = NSFileManager.defaultManager;
        if (![fm fileExistsAtPath:[root stringByAppendingPathComponent:@"meta.db"]]) {
            if ([fm fileExistsAtPath:root]) { if (error) *error = failure(@"Existing Linux filesystem requires recovery; no data was overwritten."); return NO; }
            if (![fm createDirectoryAtPath:root.stringByDeletingLastPathComponent withIntermediateDirectories:YES attributes:nil error:error]) return NO;
            NSString *staging = [root.stringByDeletingLastPathComponent stringByAppendingPathComponent:[@".install-" stringByAppendingString:NSUUID.UUID.UUIDString]];
            if (![fm copyItemAtPath:archive toPath:staging error:error]) { [fm removeItemAtPath:staging error:nil]; return NO; }
            if (![fm moveItemAtPath:staging toPath:root error:error]) { [fm removeItemAtPath:staging error:nil]; return NO; }
        }
        if (![fm createDirectoryAtPath:workspace withIntermediateDirectories:YES attributes:nil error:error]) return NO;
        int code = [ISHKernel.shared bootWithRootPath:root];
        if (!code) code = [ISHKernel.shared bindMountPath:@"/workspace" toHostPath:workspace];
        if (code) { if (error) *error = failure([NSString stringWithFormat:@"Linux initialization failed (%d).", code]); return NO; }
        mountedWorkspace = [workspace copy]; runtimeRoot = [root copy]; return YES;
    }
}
+ (void)executeID:(NSString *)identifier command:(NSString *)command cwd:(NSString *)cwd environment:(NSDictionary<NSString *,NSString *> *)environment timeout:(NSTimeInterval)timeout completion:(void (^)(NSDictionary<NSString *,id> *))completion {
    NovaShellRun *run = NovaShellRun.new; run.done = dispatch_semaphore_create(0); run.wake = dispatch_semaphore_create(0);
    @synchronized(self) {
        if (!mountedWorkspace || runs[identifier]) { completion(@{@"status":@"outcome_unknown",@"stdout":@"",@"stderr":@"Runtime unavailable or duplicate request ID.",@"exit_code":NSNull.null,@"truncated":@NO}); return; }
        runs[identifier] = run;
    }
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED,0), ^{
        NSString *token = NSUUID.UUID.UUIDString;
        NSString *guest = [@"/workspace/.nova/logs/" stringByAppendingString:token];
        NSError *error = nil;
        int rootFD = open(mountedWorkspace.fileSystemRepresentation,O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC);
        int novaFD = rootFD >= 0 ? openDirectory(rootFD,".nova") : -1;
        int logsFD = novaFD >= 0 ? openDirectory(novaFD,"logs") : -1;
        int directory = logsFD >= 0 ? openDirectory(logsFD,token.UTF8String) : -1;
        if (rootFD >= 0) close(rootFD);
        if (novaFD >= 0) close(novaFD);
        if (logsFD >= 0) close(logsFD);
        BOOL prepared = directory >= 0;
        for (NSString *name in @[@"command.sh",@"stdout",@"stderr"]) {
            if (!prepared) break;
            int fd = openat(directory,name.UTF8String,O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW|O_CLOEXEC,0600);
            if (fd < 0) { prepared = NO; break; }
            if ([name isEqualToString:@"command.sh"]) {
                NSData *data = [command dataUsingEncoding:NSUTF8StringEncoding];
                NSUInteger offset = 0;
                while (offset < data.length) {
                    ssize_t n = write(fd,(const char *)data.bytes+offset,data.length-offset);
                    if (n < 0 && errno == EINTR) continue;
                    if (n <= 0) { prepared = NO; break; }
                    offset += n;
                }
            }
            close(fd);
        }
        if (!prepared) error = failure(@"Cannot create secure workspace execution logs.");
        NSString *wrapper = [NSString stringWithFormat:@"exec >%@ 2>%@; export PATH=/workspace/.nova/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin; cd %@ || exit 125; exec /bin/sh %@",quote([guest stringByAppendingPathComponent:@"stdout"]),quote([guest stringByAppendingPathComponent:@"stderr"]),quote(cwd),quote([guest stringByAppendingPathComponent:@"command.sh"])];
        if (prepared) {
            @synchronized(run) {
                if (!run.cancelled) {
                    uint64_t ownership = 0;
                    run.pid = [ISHShellExecutor executeExecutable:@"/bin/sh" arguments:@[@"-c",wrapper] environment:environment lineCallback:nil completion:^(ISHShellExecutionResult *value) {
                        @synchronized(run) { run.result = value; run.observedExit = value.error == ISHShellExecutorErrorNone; }
                        dispatch_semaphore_signal(run.done);
                        dispatch_semaphore_signal(run.wake);
                    } ownership:&ownership];
                    run.ownership = ownership;
                }
            }
            if (run.pid > 0) {
                long expired = dispatch_semaphore_wait(run.wake,dispatch_time(DISPATCH_TIME_NOW,(int64_t)(timeout*NSEC_PER_SEC)));
                BOOL stop;
                @synchronized(run) { run.timedOut = expired && !run.cancelled && !run.observedExit; stop = run.cancelled || run.timedOut; }
                if (stop) {
                    [ISHShellExecutor killProcessGroup:run.pid ownership:run.ownership];
                    if (dispatch_semaphore_wait(run.done,dispatch_time(DISPATCH_TIME_NOW,3*NSEC_PER_SEC))) [ISHShellExecutor finalizeTimedOutPid:run.pid ownership:run.ownership];
                }
            }
        }

        NSMutableDictionary *response = [@{@"status":@"outcome_unknown",@"stdout":@"",@"stderr":error.localizedDescription ?: @"",@"exit_code":NSNull.null,@"truncated":@NO} mutableCopy];
        @synchronized(run) {
            if (run.observedExit) { response[@"status"] = run.timedOut ? @"timed_out" : (run.cancelled ? @"cancelled" : @"completed"); int waitStatus = run.result.exitCode; response[@"exit_code"] = @((waitStatus & 0x7f) == 0 ? (waitStatus >> 8) & 0xff : 128 + (waitStatus & 0x7f)); }
            else if (run.cancelled && run.pid == 0) response[@"status"] = @"cancelled";
        }
        BOOL truncated = NO;
        for (NSString *name in @[@"stdout",@"stderr"]) {
            int fd = directory >= 0 ? openat(directory,name.UTF8String,O_RDONLY|O_NOFOLLOW|O_NONBLOCK|O_CLOEXEC) : -1;
            if (fd < 0) continue;
            struct stat st;
            if (fstat(fd,&st) || !S_ISREG(st.st_mode)) { close(fd); continue; }
            NSMutableData *data = [NSMutableData dataWithLength:128*1024+1]; ssize_t n = read(fd,data.mutableBytes,data.length); close(fd);
            if (n < 0) continue;
            if (n > 128*1024) truncated = YES;
            data.length = MIN(n,128*1024);
            response[name] = decodeUTF8(data);
        }
        response[@"truncated"] = @(truncated);
        if (truncated) response[@"log_path"] = guest;
        if (directory >= 0) { unlinkat(directory,"command.sh",0); close(directory); }
        @synchronized(self) { [runs removeObjectForKey:identifier]; }
        completion(response);
    });
}
+ (BOOL)cancelID:(NSString *)identifier {
    NovaShellRun *run; @synchronized(self) { run = runs[identifier]; }
    if (!run) return NO;
    @synchronized(run) { if (run.observedExit) return NO; run.cancelled = YES; dispatch_semaphore_signal(run.wake); }
    return YES;
}
@end
