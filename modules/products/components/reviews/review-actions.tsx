"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { StarIcon } from "@heroicons/react/20/solid";
import toast from "react-hot-toast";

import { deleteReview, updateReview } from "@/actions/products/reviews/manage-review";
import { Button } from "@/components/ui/button";
import { Dialog, DialogActions, DialogBody, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

/** Edit/delete controls for the signed-in user's own review. */
export default function ReviewActions({
  review,
}: {
  review: { id: string; rating: number; review: string };
}) {
  const router = useRouter();
  const [isOpen, setIsOpen] = useState(false);
  const [rating, setRating] = useState(review.rating);
  const [body, setBody] = useState(review.review);
  const [isPending, setIsPending] = useState(false);

  const onSave = async () => {
    setIsPending(true);
    try {
      const res = await updateReview({ id: review.id, rating, review: body });
      if (!res.ok) {
        toast.error(res.message);
        return;
      }
      toast.success("Review updated");
      setIsOpen(false);
      router.refresh();
    } finally {
      setIsPending(false);
    }
  };

  const onDelete = async () => {
    if (!window.confirm("Delete your review? This cannot be undone.")) return;

    setIsPending(true);
    try {
      const res = await deleteReview(review.id);
      if (!res.ok) {
        toast.error(res.message);
        return;
      }
      toast.success("Review deleted");
      router.refresh();
    } finally {
      setIsPending(false);
    }
  };

  return (
    <div className="flex items-center gap-3 text-xs">
      <button
        type="button"
        data-testid="edit-review"
        onClick={() => setIsOpen(true)}
        className="font-medium text-blue-600 hover:underline dark:text-blue-400"
      >
        Edit
      </button>
      <button
        type="button"
        data-testid="delete-review"
        disabled={isPending}
        onClick={() => void onDelete()}
        className="font-medium text-red-600 hover:underline disabled:opacity-50 dark:text-red-400"
      >
        Delete
      </button>

      <Dialog open={isOpen} onClose={setIsOpen}>
        <DialogTitle>Edit your review</DialogTitle>
        <DialogBody>
          <div className="flex items-center gap-1">
            {[1, 2, 3, 4, 5].map((star) => (
              <button
                key={star}
                type="button"
                aria-label={`${star} star${star === 1 ? "" : "s"}`}
                onClick={() => setRating(star)}
              >
                <StarIcon
                  className={cn("size-6", star <= rating ? "text-yellow-400" : "text-gray-300")}
                />
              </button>
            ))}
          </div>
          <Textarea
            className="mt-4 w-full"
            rows={8}
            value={body}
            onChange={(event) => setBody(event.target.value)}
            aria-label="Review"
          />
        </DialogBody>
        <DialogActions>
          <Button plain type="button" onClick={() => setIsOpen(false)}>
            Cancel
          </Button>
          <Button type="button" color="sky" disabled={isPending} onClick={() => void onSave()}>
            {isPending ? "Saving…" : "Save review"}
          </Button>
        </DialogActions>
      </Dialog>
    </div>
  );
}
