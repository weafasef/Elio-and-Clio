#import <AVFoundation/AVFoundation.h>
#import <AppKit/AppKit.h>
#import <ImageIO/ImageIO.h>

@interface PhotoDelegate : NSObject <AVCapturePhotoCaptureDelegate>
@property (nonatomic, strong) NSData *data;
@property (nonatomic, strong) NSError *error;
@property (nonatomic, assign) BOOL done;
@end

@implementation PhotoDelegate
- (void)captureOutput:(AVCaptureOutput *)output
    didFinishProcessingPhoto:(AVCapturePhoto *)photo
                       error:(NSError *)error {
  self.data = [photo fileDataRepresentation];
  self.error = error;
  self.done = YES;
}
@end

static NSString *resultPath = nil;

static int writeResult(BOOL ok, NSString *message, size_t width, size_t height) {
  if (resultPath.length == 0) return 0;

  NSMutableDictionary *result = [@{
    @"ok": @(ok),
  } mutableCopy];
  if (message.length > 0) result[@"error"] = message;
  if (ok) {
    result[@"width"] = @(width);
    result[@"height"] = @(height);
  }

  NSData *data = [NSJSONSerialization dataWithJSONObject:result options:0 error:nil];
  if (data) [data writeToFile:resultPath atomically:YES];
  return 0;
}

static int fail(NSString *message, int code) {
  writeResult(NO, message, 0, 0);
  fprintf(stderr, "%s\n", message.UTF8String);
  return code;
}

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    NSString *outputPath = argc > 1
      ? [NSString stringWithUTF8String:argv[1]]
      : @"/private/tmp/eh-camera.jpg";
    resultPath = argc > 2
      ? [NSString stringWithUTF8String:argv[2]]
      : nil;

    AVAuthorizationStatus status =
      [AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeVideo];
    if (status == AVAuthorizationStatusNotDetermined) {
      dispatch_semaphore_t semaphore = dispatch_semaphore_create(0);
      __block BOOL granted = NO;
      [AVCaptureDevice requestAccessForMediaType:AVMediaTypeVideo
                              completionHandler:^(BOOL ok) {
        granted = ok;
        dispatch_semaphore_signal(semaphore);
      }];
      dispatch_semaphore_wait(semaphore, DISPATCH_TIME_FOREVER);
      if (!granted) {
        return fail(@"摄像头权限被拒绝，请到 系统设置 → 隐私与安全性 → 相机 里允许 EH Camera", 2);
      }
    } else if (status != AVAuthorizationStatusAuthorized) {
      return fail(@"摄像头权限被拒绝，请到 系统设置 → 隐私与安全性 → 相机 里允许 EH Camera", 2);
    }

    AVCaptureDevice *device =
      [AVCaptureDevice defaultDeviceWithDeviceType:AVCaptureDeviceTypeBuiltInWideAngleCamera
                                        mediaType:AVMediaTypeVideo
                                         position:AVCaptureDevicePositionFront];
    if (!device) {
      device = [AVCaptureDevice defaultDeviceWithMediaType:AVMediaTypeVideo];
    }
    if (!device) {
      return fail(@"找不到摄像头", 1);
    }

    NSError *inputError = nil;
    AVCaptureDeviceInput *input =
      [AVCaptureDeviceInput deviceInputWithDevice:device error:&inputError];
    if (!input) {
      return fail([NSString stringWithFormat:@"打开摄像头失败：%@",
                   inputError.localizedDescription ?: @"未知错误"], 1);
    }

    AVCaptureSession *session = [AVCaptureSession new];
    [session beginConfiguration];
    if ([session canSetSessionPreset:AVCaptureSessionPresetPhoto]) {
      session.sessionPreset = AVCaptureSessionPresetPhoto;
    }
    if (![session canAddInput:input]) {
      return fail(@"摄像头输入不可用", 1);
    }
    [session addInput:input];

    AVCapturePhotoOutput *photoOutput = [AVCapturePhotoOutput new];
    if (![session canAddOutput:photoOutput]) {
      return fail(@"摄像头输出不可用", 1);
    }
    [session addOutput:photoOutput];
    [session commitConfiguration];

    [session startRunning];
    [NSThread sleepForTimeInterval:1.0];

    PhotoDelegate *delegate = [PhotoDelegate new];
    AVCapturePhotoSettings *settings = [AVCapturePhotoSettings photoSettings];
    if ([photoOutput.availablePhotoCodecTypes containsObject:AVVideoCodecTypeJPEG]) {
      settings = [AVCapturePhotoSettings photoSettingsWithFormat:@{
        AVVideoCodecKey: AVVideoCodecTypeJPEG
      }];
    }
    [photoOutput capturePhotoWithSettings:settings delegate:delegate];

    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:8];
    while (!delegate.done && [deadline timeIntervalSinceNow] > 0) {
      [[NSRunLoop currentRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.05]];
    }
    [session stopRunning];

    if (delegate.error) {
      return fail([NSString stringWithFormat:@"拍照失败：%@",
                   delegate.error.localizedDescription ?: @"未知错误"], 1);
    }
    if (!delegate.data) {
      return fail(@"拍照超时", 1);
    }

    CGImageSourceRef source =
      CGImageSourceCreateWithData((__bridge CFDataRef)delegate.data, NULL);
    CGImageRef image = source ? CGImageSourceCreateImageAtIndex(source, 0, NULL) : NULL;
    if (!image) {
      return fail(@"无法读取照片数据", 1);
    }

    NSURL *outputURL = [NSURL fileURLWithPath:outputPath];
    CGImageDestinationRef destination =
      CGImageDestinationCreateWithURL((__bridge CFURLRef)outputURL, CFSTR("public.jpeg"), 1, NULL);
    if (!destination) {
      return fail(@"无法创建照片文件", 1);
    }
    NSDictionary *properties = @{
      (__bridge NSString *)kCGImageDestinationLossyCompressionQuality: @0.85
    };
    CGImageDestinationAddImage(destination, image, (__bridge CFDictionaryRef)properties);
    if (!CGImageDestinationFinalize(destination)) {
      return fail(@"无法写入照片文件", 1);
    }

    size_t width = CGImageGetWidth(image);
    size_t height = CGImageGetHeight(image);
    writeResult(YES, nil, width, height);
    printf("saved %s %zux%zu\n", outputPath.UTF8String, width, height);
  }
  return 0;
}
