import { getBasicProductDetails } from "@/actions/products/product/get-basic-details";
import { auth } from "@/auth";
import { prisma } from "@/lib/db/prisma";
import { serializePrismaObject } from "@/lib/db/serializer";
import { getRatingSummary } from "@/lib/reviews/summary";
import Reviews from "@/modules/products/components/reviews/reviews";
import ProductDescription from "@/modules/products/sections/product-description";
import { notFound } from "next/navigation";
import React from "react";

type Props = {
  params: Promise<{ id: string }>;
};

const ProductPage = async ({ params }: Props) => {
  const { id } = await params;
  const basicDetails = await getBasicProductDetails(id);

  const product = await prisma.product.findUnique({
    where: {
      id,
    },
    include: {
      images: true,
      category: true,
      options: true,
      videos: true,
      reviews: {
        take: 10,
        orderBy: {
          createdAt: "desc",
        },
        include: {
          user: {
            select: {
              id: true,
              name: true,
              profilePic: true,
            },
          },
        },
      },
    },
  });

  if (!product || !basicDetails) {
    notFound();
  }

  const session = await auth();

  // The average and star distribution cover every review; `product.reviews`
  // is only the newest ten rendered in the list.
  const [ratingSummary, myReview] = await Promise.all([
    getRatingSummary(product.id),
    session?.user?.id
      ? prisma.review.findUnique({
          where: {
            userId_productId: {
              userId: session.user.id,
              productId: product.id,
            },
          },
          include: {
            user: {
              select: {
                id: true,
                name: true,
                profilePic: true,
              },
            },
          },
        })
      : Promise.resolve(null),
  ]);

  const serializedProduct = serializePrismaObject(product);
  const serializedBasicDetails = serializePrismaObject(basicDetails);

  return (
    <div className="w-full">
      <ProductDescription
        basicDetails={serializedBasicDetails}
        product={serializedProduct}
        images={serializePrismaObject(product.images)}
      />
      <Reviews
        productId={product.id}
        session={session}
        reviews={serializePrismaObject(product.reviews ?? [])}
        myReview={serializePrismaObject(myReview)}
        ratingSummary={ratingSummary}
      />
    </div>
  );
};

export default ProductPage;
