"use server"
import { GetFeaturedPrpducts } from "@/actions/products/hot-products";
import { Badge } from "@/components/ui/badge";
import ProductCard from "@/modules/products/components/product-card";

export default async function HotProducts() {
  const products: {
    id: string;
    name: string;
    tag: string | null;
    imageSrc: string | null;
    price: number;
    imageAlt: string | null;
  }[] = await GetFeaturedPrpducts({
    take: 4,
    skip: 0
  });

  if (!products || products.length === 0) {
    return (
      <div className="mx-auto pt-6 max-w-2xl lg:max-w-7xl">
        <div className="mt-6 grid grid-cols-2 gap-x-4 gap-y-10 sm:gap-x-6 md:grid-cols-4 md:gap-y-0 lg:gap-x-8">
          {[1, 2, 3, 4].map((index) => (
            <div key={index} className="group relative">
              <div className="h-42 w-full overflow-hidden rounded-md bg-gray-200 flex items-center justify-center lg:h-52 xl:h-64">
                <div className="text-center text-gray-500">
                  <div className="w-16 h-16 mx-auto mb-2 bg-gray-300 rounded-full flex items-center justify-center">
                    <svg className="w-8 h-8 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
                    </svg>
                  </div>
                  <p className="text-xs">No Image</p>
                </div>
              </div>
              <h3 className="mt-4 text-sm text-gray-500">
                Product Name Placeholder
              </h3>
              <div className="w-full flex justify-between">
                <p className="mt-1 text-sm font-medium text-gray-500">
                  $ 0.00
                </p>
                <Badge className="text-gray-400">
                  Tag
                </Badge>
              </div>
            </div>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="mx-auto pt-6 max-w-2xl lg:max-w-7xl">
      <div className="mt-6 grid grid-cols-2 gap-x-4 gap-y-10 sm:gap-x-6 md:grid-cols-4 md:gap-y-0 lg:gap-x-8">
        {products.map((product) => (
          <ProductCard key={product.id} product={product} />
        ))}
      </div>
    </div>
  );
}