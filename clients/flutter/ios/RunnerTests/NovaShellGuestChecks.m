#import <Foundation/Foundation.h>
#import "NovaShellRuntime.h"
#import "ISHShellExecutor.h"
static NSDictionary *execute(NSString *id, NSString *command, NSTimeInterval timeout, BOOL cancel) {
    __block NSDictionary *result;
    [NovaShellRuntime executeID:id command:command cwd:@"/workspace" environment:@{} timeout:timeout completion:^(NSDictionary *r) { result = r; }];
    if (cancel) dispatch_after(dispatch_time(DISPATCH_TIME_NOW,300*NSEC_PER_MSEC),dispatch_get_main_queue(), ^{ NSCAssert([NovaShellRuntime cancelID:id],@"cancel rejected"); });
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:timeout+6];
    while (!result && deadline.timeIntervalSinceNow > 0) [[NSRunLoop currentRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.01]];
    NSCAssert(result,@"no result for %@",id);
    NSLog(@"CHECK %@: status=%@ exit=%@ stdout=%lu stderr=%@",id,result[@"status"],result[@"exit_code"],(unsigned long)[result[@"stdout"] length],result[@"stderr"]);
    return result;
}
int main(int argc, const char **argv) { @autoreleasepool {
    NSCAssert(argc == 3,@"Expected archive and external run root");
    NSString *base = @(argv[2]); NSError *error = nil;
    NSString *workspace = [base stringByAppendingPathComponent:@"workspace"];
    NSCAssert([NovaShellRuntime prepareArchive:@(argv[1]) root:[base stringByAppendingPathComponent:@"rootfs"] workspace:workspace error:&error],@"boot: %@",error);
    __block ISHShellExecutionResult *ownedResult;
    uint64_t ownership = 0;
    int ownedPid = [ISHShellExecutor executeExecutable:@"/bin/sh" arguments:@[@"-c",@"sleep 1; printf owned"] environment:@{} lineCallback:nil completion:^(ISHShellExecutionResult *result) { ownedResult = result; } ownership:&ownership];
    NSCAssert(ownedPid > 0 && ownership != 0,@"missing creation identity");
    [ISHShellExecutor killProcessGroup:ownedPid ownership:ownership+1000000];
    [ISHShellExecutor finalizeTimedOutPid:ownedPid ownership:ownership+1000000];
    NSDate *ownedDeadline = [NSDate dateWithTimeIntervalSinceNow:5];
    while (!ownedResult && ownedDeadline.timeIntervalSinceNow > 0) [[NSRunLoop currentRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.01]];
    NSCAssert(ownedResult.error == ISHShellExecutorErrorNone && ownedResult.exitCode == 0 && [ownedResult.output isEqual:@"owned"],@"stale identity affected current command");
    NSDictionary *r = execute(@"pipeline",@"mkdir -p '中文 😀'; printf 'hello\\n' > '中文 😀/file.txt'; cat '中文 😀/file.txt' | tr a-z A-Z; printf err >&2; exit 7",10,NO);
    NSCAssert([r[@"status"] isEqual:@"completed"] && [r[@"exit_code"] intValue] == 7 && [r[@"stdout"] isEqual:@"HELLO\n"] && [r[@"stderr"] isEqual:@"err"],@"pipeline failed");
    NSCAssert([[NSString stringWithContentsOfFile:[workspace stringByAppendingPathComponent:@"中文 😀/file.txt"] encoding:NSUTF8StringEncoding error:nil] isEqual:@"hello\n"],@"mapping failed");
    r = execute(@"timeout",@"sleep 30 & wait",0.3,NO);
    NSCAssert([r[@"status"] isEqual:@"timed_out"],@"timeout failed");
    r = execute(@"cancel",@"sleep 30 & wait",30,YES);
    NSCAssert([r[@"status"] isEqual:@"cancelled"],@"cancel failed");
    __block NSDictionary *other;
    [NovaShellRuntime executeID:@"other" command:@"sleep 1; printf survivor" cwd:@"/workspace" environment:@{} timeout:10 completion:^(NSDictionary *value) { other = value; }];
    r = execute(@"stubborn",@"rm -f escaped; (trap '' TERM; sleep 2; printf escaped > escaped) & wait",10,YES);
    r = execute(@"no-descendants",@"sleep 3; test ! -e escaped",10,NO);
    NSCAssert([r[@"exit_code"] intValue] == 0,@"cancelled descendants survived");
    NSCAssert([other[@"status"] isEqual:@"completed"] && [other[@"stdout"] isEqual:@"survivor"],@"cancel killed unrelated execution");
    r = execute(@"background-exit",@"rm -f late; (sleep 2; printf late > late) &",10,NO);
    NSCAssert([r[@"status"] isEqual:@"completed"],@"background parent failed");
    r = execute(@"no-orphans",@"sleep 3; test ! -e late",10,NO);
    NSCAssert([r[@"exit_code"] intValue] == 0,@"completed command left an orphan");
    r = execute(@"unicode",@"yes '中文😀' | head -c 140000",10,NO);
    NSCAssert([r[@"truncated"] boolValue] && [r[@"stdout"] hasPrefix:@"中文😀"],@"UTF8 truncation failed");
    NSString *logs = [workspace stringByAppendingPathComponent:[r[@"log_path"] substringFromIndex:11]];
    NSCAssert([[NSFileManager defaultManager] fileExistsAtPath:[logs stringByAppendingPathComponent:@"stdout"]],@"invalid log path");
    r = execute(@"interpreter",@"awk 'BEGIN { print 6 * 7 }'",10,NO);
    NSCAssert([r[@"stdout"] isEqual:@"42\n"],@"guest interpreter failed");
    if (getenv("NOVA_TEST_INSTALL_PYTHON")) {
      NSString *repo = NSProcessInfo.processInfo.environment[@"NOVA_TEST_APK_REPOSITORY"];
      NSString *repoArgument = repo.length ? [NSString stringWithFormat:@" --repositories-file /dev/null --repository '%@'",[repo stringByReplacingOccurrencesOfString:@"'" withString:@"'\\''"]] : @"";
      NSString *install = [NSString stringWithFormat:@"apk --timeout 15%@ add python3 && python3 -c 'print(6 * 7)'",repoArgument];
      r = execute(@"install-python",install,90,NO);
      NSCAssert([r[@"exit_code"] intValue] == 0 && [r[@"stdout"] hasSuffix:@"42\n"],@"package-installed Python failed");
    }
    puts("NovaShellGuestChecks passed (real iSH ARM64, macOS host)");
} return 0; }
