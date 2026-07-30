import { Slot } from '@radix-ui/react-slot';
import { cva } from 'class-variance-authority';
import type { VariantProps } from 'class-variance-authority';
import type { ComponentProps, JSX } from 'react';

import { cn } from '../../lib/utils.ts';

/**
 * Every variant clears 44px so it can be hit with a thumb, and none of them rely
 * on hover: the resting state already reads as a control.
 */
const buttonVariants = cva(
  'relative inline-flex items-center justify-center gap-2 rounded-control font-medium whitespace-nowrap transition-[opacity,background-color] select-none disabled:pointer-events-none disabled:opacity-45 active:opacity-80',
  {
    defaultVariants: { size: 'default', variant: 'solid' },
    variants: {
      size: {
        default: 'min-h-11 px-4 text-body',
        wide: 'min-h-14 w-full px-5 text-body',
      },
      variant: {
        ghost: 'text-muted',
        outline: 'border border-edge bg-transparent text-ink',
        solid: 'bg-ink text-paper',
      },
    },
  },
);

export type ButtonProps = ComponentProps<'button'> &
  VariantProps<typeof buttonVariants> & { readonly asChild?: boolean };

export const Button = ({
  asChild = false,
  className,
  size,
  variant,
  ...props
}: ButtonProps): JSX.Element => {
  const Component = asChild ? Slot : 'button';
  return <Component className={cn(buttonVariants({ className, size, variant }))} {...props} />;
};
