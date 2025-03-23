export const SITE = {
  website: "https:/yokecd.github.io/blog", // replace this with your deployed domain
  base: "blog",
  author: "David Desmarais-Michaud",
  profile: "",
  desc: "Yoke Community Blog Space",
  title: "YokeBlogSpace",
  ogImage: "",
  lightAndDarkMode: true,
  postPerIndex: 4,
  postPerPage: 4,
  scheduledPostMargin: 15 * 60 * 1000, // 15 minutes
  showArchives: false,
  showBackButton: true, // show back button in post detail
  editPost: {
    enabled: true,
    text: "Suggest Changes",
    url: "https://github.com/yokecd/blog/edit/main/",
  },
  dynamicOgImage: true,
} as const;
