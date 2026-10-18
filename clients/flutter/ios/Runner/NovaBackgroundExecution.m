#import "NovaBackgroundExecution.h"
#import <UIKit/UIKit.h>

@interface NovaBackgroundExecution ()
@property(nonatomic) FlutterMethodChannel *channel;
@property(nonatomic) NSMutableDictionary<NSString *, NSNumber *> *leases;
@property(nonatomic) NSMutableSet<NSString *> *transfers;
@property(nonatomic) NSMutableArray *events;
@property(nonatomic) UIBackgroundTaskIdentifier shortTask;
@property(nonatomic) BOOL expired, failed;
@end
@implementation NovaBackgroundExecution
+ (instancetype)shared {
    static NovaBackgroundExecution *host; static dispatch_once_t once;
    dispatch_once(&once, ^{
        host = [self new]; host.leases = [NSMutableDictionary new]; host.transfers = [NSMutableSet new];
        host.events = [NSMutableArray new]; host.shortTask = UIBackgroundTaskInvalid;
        [NSNotificationCenter.defaultCenter addObserver:host selector:@selector(enteredBackground) name:UIApplicationDidEnterBackgroundNotification object:nil];
        [NSNotificationCenter.defaultCenter addObserver:host selector:@selector(enteredForeground) name:UIApplicationDidBecomeActiveNotification object:nil];
    }); return host;
}
- (void)record:(NSString *)event {
    int64_t units = 0; for (NSNumber *value in self.leases.allValues) units += value.longLongValue;
    [self.events addObject:@{@"event":event, @"time":@([NSDate.date timeIntervalSince1970]), @"units":@(units), @"leases":@(self.leases.count), @"transfers":@(self.transfers.count), @"background":@(UIApplication.sharedApplication.applicationState == UIApplicationStateBackground)}];
    while (self.events.count > 32) [self.events removeObjectAtIndex:0];
    NSURL *folder = [NSFileManager.defaultManager URLsForDirectory:NSApplicationSupportDirectory inDomains:NSUserDomainMask].firstObject;
    [NSFileManager.defaultManager createDirectoryAtURL:folder withIntermediateDirectories:YES attributes:nil error:nil];
    NSData *data = [NSJSONSerialization dataWithJSONObject:self.events options:0 error:nil];
    [data writeToURL:[folder URLByAppendingPathComponent:@"execution-lifecycle-v1.json"] options:NSDataWritingAtomic | NSDataWritingFileProtectionCompleteUntilFirstUserAuthentication error:nil];
}
- (void)enteredBackground { if (self.leases.count) [self record:@"backgrounded"]; }
- (void)enteredForeground { if (self.leases.count && !self.expired) { [self startShortTask]; [self record:@"foregrounded"]; } }
+ (void)installWithMessenger:(NSObject<FlutterBinaryMessenger> *)messenger {
    NovaBackgroundExecution *host = self.shared;
    host.channel = [FlutterMethodChannel methodChannelWithName:@"nova/execution/v1" binaryMessenger:messenger];
    [host.channel setMethodCallHandler:^(FlutterMethodCall *call, FlutterResult reply) {
        NSDictionary *input = [call.arguments isKindOfClass:NSDictionary.class] ? call.arguments : @{};
        NSString *identifier = input[@"id"];
        if (![identifier isKindOfClass:NSString.class] || !identifier.length || identifier.length > 100) { reply([FlutterError errorWithCode:@"invalid_execution_id" message:nil details:nil]); return; }
        if ([call.method isEqualToString:@"begin"]) reply([self beginLease:identifier]);
        else if ([call.method isEqualToString:@"progress"]) {
            NSNumber *units = input[@"units"];
            if (![units isKindOfClass:NSNumber.class]) { reply([FlutterError errorWithCode:@"invalid_progress" message:nil details:nil]); return; }
            [self progressLease:identifier units:MAX(0, units.longLongValue) phase:@""]; reply(nil);
        } else if ([call.method isEqualToString:@"end"]) { [self endLease:identifier success:[input[@"success"] boolValue]]; reply(nil); }
        else reply(FlutterMethodNotImplemented);
    }];
}
- (void)startShortTask {
    if (self.shortTask != UIBackgroundTaskInvalid || self.expired || !self.leases.count) return;
    self.shortTask = [UIApplication.sharedApplication beginBackgroundTaskWithName:@"Nova checkpoint" expirationHandler:^{
        // URLSession transfers run in the system networking process. Waiting is
        // not failure: resume local processing when the completion wakes us.
        if (self.transfers.count) { [self record:@"waiting_for_network"]; [self endShortTask]; }
        else [self expire];
    }];
}
+ (NSDictionary *)beginLease:(NSString *)identifier {
    NSAssert(NSThread.isMainThread, @"Execution lifetime is owned by the main thread");
    NovaBackgroundExecution *host = self.shared;
    if (host.leases.count && host.expired) return @{@"mode":@"expired"};
    if (!host.leases.count) {
        if (UIApplication.sharedApplication.applicationState == UIApplicationStateBackground) return @{@"mode":@"foreground_required"};
        host.expired = NO; host.failed = NO;
    }
    host.leases[identifier] = @0; [host startShortTask]; [host record:@"began"];
    return @{@"mode":@"background_network"};
}
+ (void)progressLease:(NSString *)identifier units:(int64_t)units phase:(NSString *)phase {
    NovaBackgroundExecution *host = self.shared;
    NSNumber *previous = host.leases[identifier];
    if (previous && !host.expired) host.leases[identifier] = @(MAX(previous.longLongValue, units));
}
+ (void)modelTransferStarted:(NSString *)identifier {
    NovaBackgroundExecution *host = self.shared; [host.transfers addObject:identifier]; [host record:@"network_started"];
}
+ (void)modelTransferFinished:(NSString *)identifier {
    NovaBackgroundExecution *host = self.shared; [host.transfers removeObject:identifier];
    if (host.leases.count && !host.expired) [host startShortTask];
    [host record:@"network_finished"];
}
+ (void)endLease:(NSString *)identifier success:(BOOL)success {
    NovaBackgroundExecution *host = self.shared; if (!host.leases[identifier]) return;
    [host record:success ? @"lease_completed" : @"lease_interrupted"];
    [host.leases removeObjectForKey:identifier]; host.failed |= !success;
    if (!host.leases.count) [host finish:!host.failed && !host.expired];
}
+ (BOOL)hasExecutionTime {
    NovaBackgroundExecution *host = self.shared;
    return host.leases.count && !host.expired && host.shortTask != UIBackgroundTaskInvalid;
}
- (void)endShortTask {
    if (self.shortTask == UIBackgroundTaskInvalid) return;
    UIBackgroundTaskIdentifier task = self.shortTask; self.shortTask = UIBackgroundTaskInvalid;
    [UIApplication.sharedApplication endBackgroundTask:task];
}
- (void)expire {
    if (self.expired) return; self.expired = YES; [self record:@"system_expired"];
    for (NSString *identifier in self.leases.allKeys) [self.channel invokeMethod:@"expired" arguments:@{@"id":identifier}];
    [NSNotificationCenter.defaultCenter postNotificationName:@"NovaAgentExecutionExpired" object:nil];
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, NSEC_PER_SEC), dispatch_get_main_queue(), ^{ if (self.expired) [self finish:NO]; });
}
- (void)finish:(BOOL)success {
    [self record:success ? @"finished" : @"stopped"]; [self endShortTask]; [self.leases removeAllObjects];
}
@end
