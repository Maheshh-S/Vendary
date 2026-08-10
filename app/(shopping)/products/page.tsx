import { GetProducts } from "@/actions/products/products";
import ProductCard from "@/modules/products/components/product-card";

type Props = {
  searchParams: Promise<{ category?: string }>;
};

export default async function ProductsPage({ searchParams }: Props) {
  const { category } = await searchParams;
  const products = await GetProducts({ take: 24, category });

  return (
    <div className="mx-auto max-w-2xl px-4 py-10 lg:max-w-7xl">
      <h1 className="text-2xl font-bold">
        {category
          ? `${category.charAt(0).toUpperCase()}${category.slice(1)}`
          : "All Products"}
      </h1>

      {products.length === 0 ? (
        <p className="mt-10 text-center text-gray-500">
          No products found{category ? ` in ${category}` : ""} yet.
        </p>
      ) : (
        <div className="mt-8 grid grid-cols-2 gap-x-4 gap-y-10 sm:gap-x-6 md:grid-cols-3 md:gap-y-0 lg:grid-cols-4 lg:gap-x-8">
          {products.map((product) => (
            <ProductCard key={product.id} product={product} />
          ))}
        </div>
      )}
    </div>
  );
}