declare global {
  const Spicetify: any;

  interface Window {
    render?: () => unknown;
  }
}

export {};
