import React from 'react';
import { FileTypeIcon } from '@/components/icons/FileTypeIcon';
import { INLINE_REFERENCE_CHIP_CLASS } from '@/lib/messages/inlineMessageLinks';

export const AttachmentCitationChip: React.FC<{ filename: string }> = ({ filename }) => (
    <span className={INLINE_REFERENCE_CHIP_CLASS} title={filename}>
        <FileTypeIcon filePath={filename} className="h-[1.1em] w-[1.1em]" />
        {filename}
    </span>
);

