#import <Foundation/Foundation.h>
#import "../sources/PurchaseResponse.h"

@interface TestPurchaseResponse : NSObject <AutoinstallPurchaseResponseProtocol>
@property (nonatomic, strong) NSError *error;
@property (nonatomic, strong) NSArray *downloadIdentifiers;
@end

@implementation TestPurchaseResponse
@end

static void expect(BOOL condition, NSString *message) {
    if (!condition) {
        NSLog(@"%@", message);
        exit(1);
    }
}

int main(void) {
    @autoreleasepool {
        TestPurchaseResponse *success = [TestPurchaseResponse new];
        success.downloadIdentifiers = @[@1, @2];
        NSDictionary *successSummary = autoinstallPurchaseCompletionSummary(@[success]);
        expect(successSummary[@"error"] == [NSNull null], @"array-wrapped successful response must not be an error");
        expect([successSummary[@"downloadCount"] unsignedIntegerValue] == 2, @"array-wrapped download identifiers must be counted");

        TestPurchaseResponse *failure = [TestPurchaseResponse new];
        failure.error = [NSError errorWithDomain:@"StoreServices" code:17 userInfo:nil];
        NSDictionary *failureSummary = autoinstallPurchaseCompletionSummary(@[failure]);
        expect([failureSummary[@"error"] isEqual:failure.error], @"array-wrapped purchase errors must be surfaced");
        expect([failureSummary[@"responseClasses"] count] == 1, @"response class must be available for diagnostics");

        NSDictionary *emptySummary = autoinstallPurchaseCompletionSummary(@[]);
        expect([emptySummary[@"error"] isKindOfClass:[NSError class]], @"empty purchase responses must not be treated as completed");
    }
    return 0;
}
