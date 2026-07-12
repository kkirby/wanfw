"use client";

import { useState, useTransition } from "react";
import { Button, Checkbox, Group, Modal, Stack, Text } from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { deleteServiceAction } from "../actions";

export function DeleteServiceButton({ id }: { id: string }) {
  const [opened, { open, close }] = useDisclosure(false);
  const [removeVolumes, setRemoveVolumes] = useState(false);
  const [pending, startTransition] = useTransition();

  function confirm(): void {
    startTransition(async () => {
      await deleteServiceAction(id, removeVolumes);
    });
  }

  return (
    <>
      <Button color="red" variant="light" onClick={open}>
        Delete
      </Button>
      <Modal opened={opened} onClose={close} title="Delete service">
        <Stack>
          <Text size="sm">
            This removes &quot;{id}&quot; from desired state. The container and its network are garbage-collected on the next
            reconcile.
          </Text>
          <Checkbox
            label="Also delete named volumes (data loss)"
            checked={removeVolumes}
            onChange={(e) => setRemoveVolumes(e.currentTarget.checked)}
          />
          {removeVolumes && (
            <Text size="sm" c="red" fw={600}>
              Volume data will be permanently deleted. This cannot be undone.
            </Text>
          )}
          <Group justify="flex-end">
            <Button variant="default" onClick={close}>
              Cancel
            </Button>
            <Button color="red" loading={pending} onClick={confirm}>
              Delete
            </Button>
          </Group>
        </Stack>
      </Modal>
    </>
  );
}
