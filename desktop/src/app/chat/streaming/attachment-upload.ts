export type AttachmentUploadResponse = {
  _id?: string;
  storageKey?: string;
  url?: string | null;
  mimeType?: string;
  size?: number;
};

type CreateAttachmentArgs = {
  conversationId: string;
  deviceId: string;
  dataUrl: string;
};

type ScreenshotInput = {
  dataUrl: string;
};

type CreateAttachment = (
  args: CreateAttachmentArgs,
) => Promise<AttachmentUploadResponse | null>;

export type UploadedAttachment = {
  id: string;
  url?: string;
  mimeType?: string;
};

export const uploadScreenshotAttachments = async (args: {
  screenshots: ScreenshotInput[] | undefined;
  conversationId: string;
  deviceId: string;
  createAttachment: CreateAttachment;
}): Promise<UploadedAttachment[]> => {
  if (!args.screenshots?.length) {
    return [];
  }

  const uploadedAttachments: Array<UploadedAttachment | null> = await Promise.all(
    args.screenshots.map<Promise<UploadedAttachment | null>>(async (screenshot) => {
      try {
        const attachment = await args.createAttachment({
          conversationId: args.conversationId,
          deviceId: args.deviceId,
          dataUrl: screenshot.dataUrl,
        });
        const attachmentId = attachment?._id ?? attachment?.storageKey;
        if (!attachmentId) {
          return null;
        }
        return {
          id: attachmentId,
          url: attachment?.url ?? undefined,
          mimeType: attachment?.mimeType,
        };
      } catch (error) {
        console.error("Screenshot upload failed", error);
        return null;
      }
    }),
  );

  return uploadedAttachments.filter(
    (attachment): attachment is UploadedAttachment => attachment !== null,
  );
};
