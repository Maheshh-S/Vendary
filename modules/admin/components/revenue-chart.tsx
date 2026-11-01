"use client";

import { useMemo } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import type { RevenueTrendPoint } from "@/lib/analytics/queries";
import { formatINR } from "@/lib/format-inr";

type Props = {
  data: RevenueTrendPoint[];
};

/** Compact axis labels; totals keep full precision in the tooltip. */
const compactINR = (rupees: number): string => {
  if (rupees >= 10_000_000) return `₹${(rupees / 10_000_000).toFixed(1)}Cr`;
  if (rupees >= 100_000) return `₹${(rupees / 100_000).toFixed(1)}L`;
  if (rupees >= 1_000) return `₹${(rupees / 1_000).toFixed(1)}k`;
  return `₹${rupees.toFixed(0)}`;
};

const dayLabel = (day: string): string => day.slice(5);

/**
 * Client-only chart (recharts measures the DOM). The server component passes a
 * dense, plain-JSON series; every amount is converted from authoritative paise
 * to rupees here for display only.
 */
const RevenueChart = ({ data }: Props) => {
  const chartData = useMemo(
    () => data.map((point) => ({ ...point, revenue: point.revenuePaise / 100 })),
    [data]
  );

  return (
    <div className="grid gap-6 lg:grid-cols-2" data-testid="revenue-chart">
      <figure aria-label="Revenue by day">
        <figcaption className="mb-2 text-sm font-medium text-gray-700 dark:text-gray-300">
          Revenue by day (paid orders)
        </figcaption>
        <div className="h-64 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={chartData} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
              <XAxis
                dataKey="day"
                tickFormatter={dayLabel}
                tick={{ fontSize: 11 }}
                minTickGap={24}
              />
              <YAxis
                tickFormatter={(value) => compactINR(Number(value))}
                tick={{ fontSize: 11 }}
                width={70}
              />
              <Tooltip
                formatter={(value) => [formatINR(Number(value)), "Revenue"]}
                labelFormatter={(label) => String(label)}
              />
              <Line
                type="monotone"
                dataKey="revenue"
                name="Revenue"
                stroke="#0f766e"
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 4 }}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </figure>

      <figure aria-label="Orders by day">
        <figcaption className="mb-2 text-sm font-medium text-gray-700 dark:text-gray-300">
          Paid orders by day
        </figcaption>
        <div className="h-64 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chartData} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
              <XAxis
                dataKey="day"
                tickFormatter={dayLabel}
                tick={{ fontSize: 11 }}
                minTickGap={24}
              />
              <YAxis allowDecimals={false} tick={{ fontSize: 11 }} width={40} />
              <Tooltip
                formatter={(value) => [String(Number(value)), "Orders"]}
                labelFormatter={(label) => String(label)}
              />
              <Bar dataKey="orders" name="Orders" fill="#334155" radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </figure>
    </div>
  );
};

export default RevenueChart;
