import { getBasicProductDetails } from "@/actions/products/product/get-basic-details";
import { auth } from "@/auth";
import { prisma } from "@/lib/db/prisma";
import { serializePrismaObject } from "@/lib/db/serializer";
import { getAlsoBought } from "@/lib/recommendations";
import { getRatingSummary } from "@/lib/reviews/summary";
import AlsoBought from "@/modules/products/components/also-bought";
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
  const [ratingSummary, myReview, wishlistedRow, alsoBought] = await Promise.all([
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
    session?.user?.id
      ? prisma.wishlistItem.findUnique({
          where: {
            userId_productId: {
              userId: session.user.id,
              productId: product.id,
            },
          },
          select: { id: true },
        })
      : Promise.resolve(null),
    // Co-purchase recommendations degrade to featured/in-stock products and
    // never throw, so they cannot block the product page.
    getAlsoBought(product.id),
  ]);

  const serializedProduct = serializePrismaObject(product);
  const serializedBasicDetails = serializePrismaObject(basicDetails);

  return (
    <div className="w-full">
      <ProductDescription
        basicDetails={serializedBasicDetails}
        product={serializedProduct}
        images={serializePrismaObject(product.images)}
        wishlist={{
          isAuthenticated: Boolean(session?.user?.id),
          inWishlist: wishlistedRow !== null,
        }}
      />
      <Reviews
        productId={product.id}
        session={session}
        reviews={serializePrismaObject(product.reviews ?? [])}
        myReview={serializePrismaObject(myReview)}
        ratingSummary={ratingSummary}
      />
      <AlsoBought products={alsoBought} />
    </div>
  );
};

export default ProductPage;
