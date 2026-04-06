// Copyright 2025 OfficeCli (officecli.ai)
// SPDX-License-Identifier: Apache-2.0

using System.Text.RegularExpressions;
using DocumentFormat.OpenXml;
using DocumentFormat.OpenXml.Packaging;
using DocumentFormat.OpenXml.Presentation;
using OfficeCli.Core;
using Drawing = DocumentFormat.OpenXml.Drawing;
using C = DocumentFormat.OpenXml.Drawing.Charts;
using M = DocumentFormat.OpenXml.Math;

namespace OfficeCli.Handlers;

public partial class PowerPointHandler
{
    private string AddSlide(string parentPath, int? index, Dictionary<string, string> properties)
    {
                properties ??= new Dictionary<string, string>();
                var presentationPart = _doc.PresentationPart
                    ?? throw new InvalidOperationException("Presentation not found");
                var presentation = presentationPart.Presentation
                    ?? throw new InvalidOperationException("No presentation");
                var slideIdList = presentation.GetFirstChild<SlideIdList>()
                    ?? presentation.AppendChild(new SlideIdList());

                var newSlidePart = presentationPart.AddNewPart<SlidePart>();

                // Link slide to slideLayout (required by PowerPoint)
                var slideLayoutPart = ResolveSlideLayout(
                    presentationPart, properties.GetValueOrDefault("layout"));
                if (slideLayoutPart != null)
                    newSlidePart.AddPart(slideLayoutPart);

                newSlidePart.Slide = new Slide(
                    new CommonSlideData(
                        new ShapeTree(
                            new NonVisualGroupShapeProperties(
                                new NonVisualDrawingProperties { Id = 1, Name = "" },
                                new NonVisualGroupShapeDrawingProperties(),
                                new ApplicationNonVisualDrawingProperties()),
                            new GroupShapeProperties()
                        )
                    )
                );

                // Add title shape if text provided (ID starts at 2 since ShapeTree group uses ID=1)
                uint nextShapeId = 2;
                if (properties.TryGetValue("title", out var titleText))
                {
                    var titleShape = CreateTextShape(nextShapeId++, "Title", titleText, true);
                    newSlidePart.Slide.CommonSlideData!.ShapeTree!.AppendChild(titleShape);
                }

                // Add content text if provided
                if (properties.TryGetValue("text", out var contentText))
                {
                    var textShape = CreateTextShape(nextShapeId++, "Content", contentText, false);
                    newSlidePart.Slide.CommonSlideData!.ShapeTree!.AppendChild(textShape);
                }

                // Apply background if provided
                if (properties.TryGetValue("background", out var bgValue))
                    ApplySlideBackground(newSlidePart, bgValue);

                // Apply transition if provided
                if (properties.TryGetValue("transition", out var transValue))
                {
                    ApplyTransition(newSlidePart, transValue);
                    if (transValue.StartsWith("morph", StringComparison.OrdinalIgnoreCase))
                        AutoPrefixMorphNames(newSlidePart);
                }
                if (properties.TryGetValue("advancetime", out var advTime) || properties.TryGetValue("advanceTime", out advTime))
                    SetAdvanceTime(newSlidePart.Slide, advTime);
                if (properties.TryGetValue("advanceclick", out var advClick) || properties.TryGetValue("advanceClick", out advClick))
                    SetAdvanceClick(newSlidePart.Slide, IsTruthy(advClick));

                newSlidePart.Slide.Save();

                var maxId = slideIdList.Elements<SlideId>().Any()
                    ? slideIdList.Elements<SlideId>().Max(s => s.Id?.Value ?? 255) + 1
                    : 256;
                var relId = presentationPart.GetIdOfPart(newSlidePart);

                if (index.HasValue && index.Value < slideIdList.Elements<SlideId>().Count())
                {
                    var refSlide = slideIdList.Elements<SlideId>().ElementAtOrDefault(index.Value);
                    if (refSlide != null)
                        slideIdList.InsertBefore(new SlideId { Id = maxId, RelationshipId = relId }, refSlide);
                    else
                        slideIdList.AppendChild(new SlideId { Id = maxId, RelationshipId = relId });
                }
                else
                {
                    slideIdList.AppendChild(new SlideId { Id = maxId, RelationshipId = relId });
                }

                presentation.Save();
                // Find the actual position of the inserted slide
                var slideIds = slideIdList.Elements<SlideId>().ToList();
                var insertedIdx = slideIds.FindIndex(s => s.RelationshipId?.Value == relId) + 1;
                return $"/slide[{insertedIdx}]";
    }


}
