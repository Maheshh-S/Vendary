"use client"
import React, { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogActions,
  DialogBody,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, Label } from "@/components/ui/fieldset";
import { Pencil } from "lucide-react";
import { Textarea } from "@/components/ui/textarea";
import { useMutation } from "@tanstack/react-query";
import { editLongDescription, editShortDescription } from "@/actions/(admin)/edit/description";
import toast from "react-hot-toast";

type Props = {
  description: string | null;
  shortDescription: string | null;
  productId: string;
};

const DescriptionForm = ({ description, shortDescription, productId }: Props) => {
  const [isOpen, setIsOpen] = useState(false);
  const [shortDescriptionValue, setShortDescriptionValue] = useState<string | null>(shortDescription);
  const [longDescriptionValue, setLongDescriptionValue] = useState<string | null>(description);

  const {
    mutate: updateShortDescription,
    isPending: isShortDescriptionPending,
  } = useMutation({
    mutationKey: ["update-short-description", productId],
    mutationFn: editShortDescription,
    onSuccess: (res) => {
      if (!res.ok) {
        toast.error(res.message);
        return;
      }
      toast.success("Short Description Updated");
    },
    onError: () => {
      toast.error("Failed to update short description");
    }
  });

  const {
    mutate: updateLongDescription,
    isPending: isLongDescriptionPending,
  } = useMutation({
    mutationKey: ["update-long-description", productId],
    mutationFn: editLongDescription,
    onSuccess: (res) => {
      if (!res.ok) {
        toast.error(res.message);
        return;
      }
      toast.success("Long Description Updated");
    },
    onError: () => {
      toast.error("Failed to update long description");
    }
  });

  const handleShortBlur = () => {
    if (shortDescriptionValue !== shortDescription) {
      updateShortDescription({
        productId,
        shortDescription: shortDescriptionValue || "",
      });
    }
  };

  const handleLongBlur = () => {
    if (longDescriptionValue !== description) {
      updateLongDescription({
        productId,
        longDescription: longDescriptionValue || "",
      });
    }
  };

  return (
    <>
      <Button outline type="button" onClick={() => setIsOpen(true)}>
        <Pencil size={16} />
      </Button>
      <Dialog open={isOpen} onClose={setIsOpen}>
        <DialogTitle>Edit Descriptions</DialogTitle>
        <DialogDescription>
          Edit both short description and long description here.
        </DialogDescription>
        <DialogBody>
          <Field>
            <Label>Short Description</Label>
            <Textarea
              name="short-description"
              placeholder="Enter Short Description Here"
              value={shortDescriptionValue || ""}
              onChange={(e) => setShortDescriptionValue(e.target.value)}
              onBlur={handleShortBlur}
              rows={4}
              disabled={isShortDescriptionPending}
            />
          </Field>
        </DialogBody>
        <DialogBody>
          <Field>
            <Label>Long Description</Label>
            <Textarea
              name="long-description"
              placeholder="Enter Long Description Here"
              value={longDescriptionValue || ""}
              onChange={(e) => setLongDescriptionValue(e.target.value)}
              onBlur={handleLongBlur}
              rows={7}
              disabled={isLongDescriptionPending}
            />
          </Field>
        </DialogBody>
        <DialogActions>
          <Button plain onClick={() => setIsOpen(false)}>
            Cancel
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
};

export default DescriptionForm;
