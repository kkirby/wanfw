"use client";

import { useState } from "react";
import { Alert, Button, FileInput, Group, Progress, Stack, Text } from "@mantine/core";
import { useRouter } from "next/navigation";

export function UploadForm() {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  async function handleUpload() {
    if (!file) return;
    setUploading(true);
    setError(null);
    setSuccess(null);
    try {
      const res = await fetch("/api/plugins/upload", {
        method: "POST",
        headers: { "content-type": "application/octet-stream", "x-bundle-name": file.name },
        body: file,
      });
      const body = (await res.json()) as { sha256?: string; error?: string; message?: string };
      if (!res.ok) {
        setError(body.message ?? body.error ?? `upload failed (${res.status})`);
      } else {
        setSuccess(`staged, hash ${body.sha256}`);
        setFile(null);
        router.refresh();
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setUploading(false);
    }
  }

  return (
    <Stack>
      {error && <Alert color="red">{error}</Alert>}
      {success && <Alert color="green">{success}</Alert>}
      <FileInput
        placeholder="Plugin bundle (.tar, max 50 MB)"
        value={file}
        onChange={setFile}
        disabled={uploading}
        accept=".tar,.tar.gz,.tgz"
      />
      {uploading && <Progress value={100} animated />}
      <Group>
        <Button onClick={handleUpload} disabled={!file || uploading} loading={uploading}>
          Upload
        </Button>
        <Text size="xs" c="dimmed">
          Upload only stages the bundle. Trust it from the host with the printed command.
        </Text>
      </Group>
    </Stack>
  );
}
